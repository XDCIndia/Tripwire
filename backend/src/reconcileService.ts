/**
 * Reconciliation service (issue #50).
 *
 * Owns the loop the issue describes: a canonical verdict is *recorded* with
 * its expected enforcement, then independently checked against the chain
 * ("on-chain state reader -> compare expected vs actual"). Unresolved
 * outcomes are re-checked automatically until they settle or hit the
 * re-check ceiling; MISMATCHes raise alerts (escalation hooks) and are
 * never promoted to MATCH by a later healthy check - they remain the
 * security-critical signal they are.
 *
 * The chain is behind the `ReconcileChainReader` interface so every
 * decision here is testable with a stub; `reconcileChain.ts` is the real
 * viem implementation.
 */

import {
  type ChainStateSnapshot,
  type ReconciliationResult,
  type ReconciliationStatus,
  type RegistryVerdictState,
  DEFAULT_MAX_RECHECKS,
  DEFAULT_RECHECK_DELAY_MS,
} from "./reconcileTypes.js"
import { type GuardSnapshot, expectedEnforcementOf, reconcile } from "./reconcileEngine.js"
import {
  type EnforcementRecord,
  type ReconciliationStore,
  type ReconciliationEvent,
  createInMemoryReconcileStore,
} from "./reconcileStore.js"

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReconciliationError"
  }
}

/** Reads the current on-chain state for one Safe transaction hash. */
export interface ReconcileChainReader {
  readState(safeTxHash: string, enforcementTxHash: string | null): Promise<ChainStateSnapshot>
}

export interface RecordEnforcementInput {
  safeTxHash: string
  /** The verdict that was written to RiskRegistry. */
  verdictAtSubmit: RegistryVerdictState
  /** Transaction value in wei, for Guard-limit expectations. */
  value: bigint
  /** Guard config as read at submit time. */
  guardAtSubmit: GuardSnapshot
  /** Stable verdict id, for correlation with the audit ledger. */
  verdictId?: string | null
  /** On-chain hash of the enforcement attempt, when already known. */
  enforcementTxHash?: string | null
}

export interface ReconciliationAlert {
  severity: "critical"
  kind: "enforcement_mismatch" | "protection_not_active"
  safeTxHash: string
  verdictId: string | null
  message: string
  at: number
}

export interface ReconciliationServiceOptions {
  reader: ReconcileChainReader
  now?: () => number
  recheckDelayMs?: number
  maxRechecks?: number
  /** Called for every critical alert; sink failures must not throw. */
  onAlert?: (alert: ReconciliationAlert) => void
}

export interface CheckOutcome {
  record: EnforcementRecord
  result: ReconciliationResult
}

export class ReconciliationService {
  private readonly now: () => number
  private readonly reader: ReconcileChainReader
  private readonly recheckDelayMs: number
  private readonly maxRechecks: number
  private readonly onAlert?: (alert: ReconciliationAlert) => void

  constructor(
    private readonly store: ReconciliationStore = createInMemoryReconcileStore(),
    options: ReconciliationServiceOptions,
  ) {
    this.reader = options.reader
    this.now = options.now ?? (() => Date.now())
    this.recheckDelayMs = options.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS
    this.maxRechecks = options.maxRechecks ?? DEFAULT_MAX_RECHECKS
    this.onAlert = options.onAlert
  }

  /** The store backing this service (status reads, audit). */
  get log(): ReconciliationStore {
    return this.store
  }

  // ------------------------------------------------------------------
  // Records
  // ------------------------------------------------------------------

  /**
   * Registers a canonical verdict for attestation and derives its expected
   * enforcement. One record per Safe transaction hash: re-registering the
   * same transaction would silently overwrite what was expected - so it is
   * refused, not ignored.
   */
  recordEnforcement(input: RecordEnforcementInput): EnforcementRecord {
    if (this.getRecord(input.safeTxHash)) {
      throw new ReconciliationError(
        `a verdict for ${input.safeTxHash} is already recorded - re-registration would silently change expectations`,
      )
    }
    const at = this.now()
    const expected = expectedEnforcementOf(input.verdictAtSubmit, {
      value: input.value,
      now: at,
      guard: input.guardAtSubmit,
    })
    const record: EnforcementRecord = {
      safeTxHash: input.safeTxHash,
      verdictId: input.verdictId ?? null,
      verdictAtSubmit: input.verdictAtSubmit,
      value: input.value.toString(),
      guardAtSubmit: {
        frozen: input.guardAtSubmit.frozen,
        perTxLimit: input.guardAtSubmit.perTxLimit.toString(),
        rollingLimit: input.guardAtSubmit.rollingLimit.toString(),
        windowSpent: input.guardAtSubmit.windowSpent.toString(),
      },
      expected,
      enforcementTxHash: input.enforcementTxHash ?? null,
      recordedAt: at,
      updatedAt: at,
      rechecks: 0,
      latest: null,
      mismatchAt: null,
    }
    this.store.append({ txHash: input.safeTxHash, at, kind: "recorded", record })
    return record
  }

  getRecord(safeTxHash: string): EnforcementRecord | undefined {
    return this.store.readRecords().find((record) => record.safeTxHash === safeTxHash)
  }

  /** Latest records, optionally filtered. */
  records(query: { status?: ReconciliationStatus; txHash?: string } = {}): EnforcementRecord[] {
    return this.store
      .readRecords()
      .filter((record) => {
        if (query.status !== undefined && record.latest?.status !== query.status) return false
        if (query.txHash !== undefined && record.safeTxHash !== query.txHash) return false
        return true
      })
      .sort((a, b) => b.recordedAt - a.recordedAt)
  }

  /** Immutable check history for one transaction. */
  historyOf(safeTxHash: string): ReconciliationEvent[] {
    return this.store.readHistory(safeTxHash)
  }

  // ------------------------------------------------------------------
  // Checking
  // ------------------------------------------------------------------

  /**
   * Runs one independent on-chain check for a recorded verdict: read the
   * chain, compare against the stored expectation, persist the outcome, and
   * alert on critical drift. Returns the fresh result.
   */
  async check(safeTxHash: string): Promise<CheckOutcome> {
    const record = this.getRecord(safeTxHash)
    if (!record) throw new ReconciliationError(`no recorded verdict for ${safeTxHash} - record it first`)
    const at = this.now()

    const current = await this.reader.readState(safeTxHash, record.enforcementTxHash)
    const result = reconcile({
      expected: record.expected,
      current,
      value: BigInt(record.value),
      now: at,
    })

    // The mismatch latch: the first MISMATCH is recorded forever, even
    // though `latest` keeps tracking the most recent (possibly recovered)
    // outcome. An incident can never be silently erased by a later healthy
    // check - it becomes a permanent, auditable part of the record, and
    // dashboards reading `latest` next to `mismatchAt` can tell "mismatched
    // before, now healthy" apart from "never mismatched".
    const updated: EnforcementRecord = {
      ...record,
      latest: result,
      updatedAt: at,
      rechecks: record.rechecks + 1,
      mismatchAt: record.mismatchAt ?? (result.critical ? at : null),
    }
    this.store.append({ txHash: safeTxHash, at, kind: "checked", record: updated })
    if (result.critical) this.raiseAlert(updated)
    return { record: updated, result }
  }

  // ------------------------------------------------------------------
  // Automatic re-checking of unresolved outcomes
  // ------------------------------------------------------------------

  /** Records whose outcome is unresolved (never checked, or PENDING) and due
   * for another automatic check within the re-check ceiling. */
  dueRecords(now: number = this.now()): EnforcementRecord[] {
    return this.store.readRecords().filter((record) => {
      if (record.rechecks >= this.maxRechecks) return false
      const latest = record.latest
      if (!latest) return true
      if (latest.status !== "PENDING") return false
      return this.nextCheckAt(record) <= now
    })
  }

  /** When a PENDING record may next be re-checked (never faster than the
   * configured cadence - PENDING is a backoff, not a busy loop). */
  nextCheckAt(record: EnforcementRecord, now: number = this.now()): number {
    const latest = record.latest
    const base = latest?.checkedAt ?? record.recordedAt
    const earliest = base + this.recheckDelayMs
    return latest && latest.recheckAt !== null ? Math.max(latest.recheckAt, earliest) : earliest
  }

  /**
   * One full reconciliation cycle: every due record is checked; critical
   * outcomes produce alerts (invoked synchronously via `onAlert`).
   */
  async runDueCycle(now: number = this.now()): Promise<{ checked: CheckOutcome[]; alerts: ReconciliationAlert[] }> {
    const alerts: ReconciliationAlert[] = []
    const checked: CheckOutcome[] = []
    for (const record of this.dueRecords(now)) {
      const outcome = await this.check(record.safeTxHash)
      checked.push(outcome)
      if (outcome.result.critical) {
        const alert = this.alertFor(outcome.record)
        alerts.push(alert)
        this.onAlert?.(alert)
      }
    }
    return { checked, alerts }
  }

  /** Polls `runDueCycle` forever; returns a stop handle. */
  start(pollIntervalMs = this.recheckDelayMs): () => void {
    const handle = setInterval(() => {
      this.runDueCycle().catch((error: unknown) => {
        console.error("[reconcile] cycle failed:", error)
      })
    }, pollIntervalMs)
    return () => clearInterval(handle)
  }

  // ------------------------------------------------------------------

  private raiseAlert(record: EnforcementRecord): void {
    const alert = this.alertFor(record)
    try {
      this.onAlert?.(alert)
    } catch {
      /* escalation hooks must never take the reconciliation loop down */
    }
  }

  private alertFor(record: EnforcementRecord): ReconciliationAlert {
    const latest = record.latest
    const notes = latest?.notes ?? []
    return {
      severity: "critical",
      kind: notes.some((note) => note.includes("not active")) ? "protection_not_active" : "enforcement_mismatch",
      safeTxHash: record.safeTxHash,
      verdictId: record.verdictId,
      message: `Verdict ${record.expected.action} for ${record.safeTxHash} was NOT enforced: ${notes.join(" ")}`,
      at: latest?.checkedAt ?? this.now(),
    }
  }
}


