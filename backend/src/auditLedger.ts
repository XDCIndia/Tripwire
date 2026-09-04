/**
 * Issue #52: Risk Decision Audit Trail & Explainability Ledger
 *
 * Append-oriented audit service that records the complete lifecycle of
 * every Safe transaction risk decision — from detection through
 * individual analysis results, final verdict, enforcement, and
 * on-chain reconciliation.
 *
 * Design principles:
 *   - Append-only: events are never overwritten, only appended
 *   - Correlated by (txHash, verdictId) — stable identifiers
 *   - Complete timeline reconstruction for any transaction
 *   - Filterable by Safe address, tx hash, verdict ID, risk level, status
 */

import { randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum AuditEventType {
  TRANSACTION_DETECTED = "TRANSACTION_DETECTED",
  ANALYSIS_STARTED = "ANALYSIS_STARTED",
  ANALYSIS_COMPLETED = "ANALYSIS_COMPLETED",
  ANALYSIS_FAILED = "ANALYSIS_FAILED",
  VERDICT_GENERATED = "VERDICT_GENERATED",
  ENFORCEMENT_SUBMITTED = "ENFORCEMENT_SUBMITTED",
  ENFORCEMENT_CONFIRMED = "ENFORCEMENT_CONFIRMED",
  ENFORCEMENT_FAILED = "ENFORCEMENT_FAILED",
  RECONCILIATION_CHECKED = "RECONCILIATION_CHECKED",
  RECONCILIATION_MISMATCH = "RECONCILIATION_MISMATCH",
  JOB_CREATED = "JOB_CREATED",
  JOB_COMPLETED = "JOB_COMPLETED",
  JOB_FAILED = "JOB_FAILED",
  JOB_RETRIED = "JOB_RETRIED",
  JOB_DEAD_LETTERED = "JOB_DEAD_LETTERED",
  POLICY_VERSION_CHANGED = "POLICY_VERSION_CHANGED",
}

export enum RiskLevel {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  UNKNOWN = "unknown",
}

export interface AuditEvent {
  id: string
  txHash: string
  verdictId: string | null
  eventType: AuditEventType
  timestamp: number
  safeAddress: string
  chainId: number
  /** Freeform event payload — structured per event type. */
  payload: unknown
}

export interface TransactionAuditRecord {
  txHash: string
  safeAddress: string
  chainId: number
  events: AuditEvent[]
  /** Derived from the latest VERDICT_GENERATED event. */
  currentVerdict: VerdictSnapshot | null
  /** Derived from the latest ENFORCEMENT event. */
  enforcementStatus: EnforcementSnapshot | null
  /** Derived from the latest RECONCILIATION event. */
  reconciliationStatus: ReconciliationSnapshot | null
  createdAt: number
  updatedAt: number
}

export interface VerdictSnapshot {
  verdictId: string
  score: number
  riskLevel: RiskLevel
  action: string
  explanation: string
  policyVersion: string
  ruleVersion: string
  simulationVersion: string
  llmVersion: string | null
}

export interface EnforcementSnapshot {
  txHash: string
  status: "SUBMITTED" | "CONFIRMED" | "FAILED"
  enforcementTxHash: string | null
  error: string | null
  timestamp: number
}

export interface ReconciliationSnapshot {
  expected: string
  actual: string
  status: "MATCH" | "MISMATCH" | "PENDING"
  timestamp: number
}

export interface AuditFilter {
  safeAddress?: string
  txHash?: string
  verdictId?: string
  riskLevel?: RiskLevel
  eventType?: AuditEventType
  fromTimestamp?: number
  toTimestamp?: number
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// AuditLedger interface + in-memory implementation
// ---------------------------------------------------------------------------

export interface AuditLedger {
  /** Append an event to the audit trail. */
  append(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent
  /** Get the complete audit record for a transaction. */
  getRecord(txHash: string): TransactionAuditRecord | null
  /** Get all events for a transaction. */
  getEvents(txHash: string): AuditEvent[]
  /** Query events with filters. */
  query(filter: AuditFilter): AuditEvent[]
  /** Get all unique transaction hashes. */
  listTxHashes(): string[]
  /** Get summary statistics. */
  stats(): {
    totalEvents: number
    totalTransactions: number
    eventsByType: Record<string, number>
    riskLevelDistribution: Record<string, number>
  }
}

export class InMemoryAuditLedger implements AuditLedger {
  private readonly events: AuditEvent[] = []
  private readonly records = new Map<string, TransactionAuditRecord>()

  append(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
    const fullEvent: AuditEvent = {
      ...event,
      id: randomUUID(),
      timestamp: Date.now(),
    }
    this.events.push(fullEvent)

    // Update or create the transaction record.
    let record = this.records.get(event.txHash)
    if (!record) {
      record = {
        txHash: event.txHash,
        safeAddress: event.safeAddress,
        chainId: event.chainId,
        events: [],
        currentVerdict: null,
        enforcementStatus: null,
        reconciliationStatus: null,
        createdAt: fullEvent.timestamp,
        updatedAt: fullEvent.timestamp,
      }
      this.records.set(event.txHash, record)
    }
    record.events.push(fullEvent)
    record.updatedAt = fullEvent.timestamp

    // Update derived snapshots.
    if (event.eventType === AuditEventType.VERDICT_GENERATED) {
      record.currentVerdict = event.payload as unknown as VerdictSnapshot
    } else if (event.eventType === AuditEventType.ENFORCEMENT_CONFIRMED || event.eventType === AuditEventType.ENFORCEMENT_FAILED) {
      record.enforcementStatus = event.payload as unknown as EnforcementSnapshot
    } else if (event.eventType === AuditEventType.RECONCILIATION_CHECKED || event.eventType === AuditEventType.RECONCILIATION_MISMATCH) {
      record.reconciliationStatus = event.payload as unknown as ReconciliationSnapshot
    }

    return fullEvent
  }

  getRecord(txHash: string): TransactionAuditRecord | null {
    return this.records.get(txHash) ?? null
  }

  getEvents(txHash: string): AuditEvent[] {
    return this.events.filter((e) => e.txHash === txHash)
  }

  query(filter: AuditFilter): AuditEvent[] {
    let results = [...this.events]

    if (filter.safeAddress) {
      results = results.filter((e) => e.safeAddress === filter.safeAddress)
    }
    if (filter.txHash) {
      results = results.filter((e) => e.txHash === filter.txHash)
    }
    if (filter.verdictId) {
      results = results.filter((e) => e.verdictId === filter.verdictId)
    }
    if (filter.eventType) {
      results = results.filter((e) => e.eventType === filter.eventType)
    }
    if (filter.fromTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.fromTimestamp!)
    }
    if (filter.toTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp <= filter.toTimestamp!)
    }

    // Risk level filtering requires looking at the payload of VERDICT_GENERATED events.
    if (filter.riskLevel) {
      const riskTxHashes = new Set(
        this.events
          .filter(
            (e) =>
              e.eventType === AuditEventType.VERDICT_GENERATED &&
              (e.payload as Record<string, unknown>).riskLevel === filter.riskLevel,
          )
          .map((e) => e.txHash),
      )
      results = results.filter((e) => riskTxHashes.has(e.txHash))
    }

    // Sort by timestamp ascending.
    results.sort((a, b) => a.timestamp - b.timestamp)

    // Apply pagination.
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? results.length
    return results.slice(offset, offset + limit)
  }

  listTxHashes(): string[] {
    return [...this.records.keys()]
  }

  stats() {
    const eventsByType: Record<string, number> = {}
    const riskLevelDistribution: Record<string, number> = {}

    for (const event of this.events) {
      eventsByType[event.eventType] = (eventsByType[event.eventType] ?? 0) + 1
      if (event.eventType === AuditEventType.VERDICT_GENERATED) {
        const level = (event.payload as Record<string, unknown>).riskLevel as string
        riskLevelDistribution[level] = (riskLevelDistribution[level] ?? 0) + 1
      }
    }

    return {
      totalEvents: this.events.length,
      totalTransactions: this.records.size,
      eventsByType,
      riskLevelDistribution,
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers for creating common events
// ---------------------------------------------------------------------------

export function auditTransactionDetected(
  txHash: string,
  safeAddress: string,
  chainId: number,
  details: Record<string, unknown>,
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId: null,
    eventType: AuditEventType.TRANSACTION_DETECTED,
    safeAddress,
    chainId,
    payload: details,
  }
}

export function auditAnalysisCompleted(
  txHash: string,
  verdictId: string,
  safeAddress: string,
  chainId: number,
  analysisType: string,
  result: unknown,
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId,
    eventType: AuditEventType.ANALYSIS_COMPLETED,
    safeAddress,
    chainId,
    payload: { analysisType, result },
  }
}

export function auditVerdictGenerated(
  txHash: string,
  verdictId: string,
  safeAddress: string,
  chainId: number,
  verdict: VerdictSnapshot,
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId,
    eventType: AuditEventType.VERDICT_GENERATED,
    safeAddress,
    chainId,
    payload: verdict,
  }
}

export function auditEnforcementSubmitted(
  txHash: string,
  verdictId: string,
  safeAddress: string,
  chainId: number,
  enforcementTxHash: string,
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId,
    eventType: AuditEventType.ENFORCEMENT_SUBMITTED,
    safeAddress,
    chainId,
    payload: { enforcementTxHash, status: "SUBMITTED" },
  }
}

export function auditEnforcementConfirmed(
  txHash: string,
  verdictId: string,
  safeAddress: string,
  chainId: number,
  enforcementTxHash: string,
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId,
    eventType: AuditEventType.ENFORCEMENT_CONFIRMED,
    safeAddress,
    chainId,
    payload: {
      txHash: enforcementTxHash,
      status: "CONFIRMED",
      enforcementTxHash,
      error: null,
      timestamp: Date.now(),
    } satisfies EnforcementSnapshot,
  }
}

export function auditReconciliation(
  txHash: string,
  verdictId: string,
  safeAddress: string,
  chainId: number,
  expected: string,
  actual: string,
  status: "MATCH" | "MISMATCH" | "PENDING",
): Omit<AuditEvent, "id" | "timestamp"> {
  return {
    txHash,
    verdictId,
    eventType: status === "MISMATCH" ? AuditEventType.RECONCILIATION_MISMATCH : AuditEventType.RECONCILIATION_CHECKED,
    safeAddress,
    chainId,
    payload: {
      expected,
      actual,
      status,
      timestamp: Date.now(),
    } satisfies ReconciliationSnapshot,
  }
}
