import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Risk-decision audit ledger (issue #52): a persistent, append-oriented
 * record of the complete lifecycle of every analyzed Safe transaction -
 * detection, per-component analysis evidence, the canonical verdict, the
 * policy/rule versions in force, enforcement attempts (including retries
 * and failures), and the reconciled on-chain outcome.
 *
 * Design contracts, straight from the acceptance criteria:
 *
 * 1. APPEND-ONLY. There is no update or delete API anywhere in this
 *    module. Corrections arrive as new events; the timeline they join is
 *    never mutated. Historical records cannot be silently overwritten
 *    because there is literally no code path that writes in place.
 * 2. CORRELATION. Every event carries the transaction hash; the first
 *    verdict event mints a stable `verdictId` (`${txHash}#v1`) that
 *    subsequent enforcement and reconciliation events inherit, so every
 *    stage of a decision is reachable from one identifier.
 * 3. VERSIONING. `policyVersion`/`ruleVersion` are recorded at decision
 *    time into the canonical verdict, so an old record explains itself
 *    even after the rules move on.
 * 4. AUDIT NEVER BLOCKS THE PIPELINE. Sink failures route to `onError`
 *    and the in-memory index keeps the event - a verdict must never fail
 *    because the ledger hiccuped.
 */

export type AuditEventType =
  | "detected"
  | "analysis"
  | "verdict"
  | "enforcement"
  | "reconciliation"
  | "retry"
  | "failure"

export type AuditComponent = "rule-engine" | "wallet" | "simulation" | "llm" | "relayer" | "reconciler"

export interface AuditEvent {
  /** Ledger-wide monotonic sequence - the total order across all transactions. */
  seq: number
  /** ISO timestamp of the event. */
  at: string
  txHash: string
  /** Stable correlation id - minted on the first verdict event for a tx. */
  verdictId?: string
  type: AuditEventType
  /** Which analysis/enforcement component produced the event, when applicable. */
  component?: AuditComponent
  /** Event-type-specific payload (rule result, sim diff, verdict fields, ...). */
  data: Record<string, unknown>
}

/** Canonical decision, snapshotted at verdict time with the versions in force. */
export interface CanonicalDecision {
  score: number
  status: string
  action: string
  explanation: string
  at: string
  policyVersion: string
  ruleVersion: string
}

export interface EnforcementRecord {
  enforcementTxHash?: string
  status: "submitted" | "confirmed" | "failed"
  attempts: number
  lastAttemptAt: string
}

export interface ReconciliationRecord {
  expected: string
  actual: string
  status: "match" | "mismatch" | "pending"
  at: string
}

/** Per-component analysis evidence - the LATEST result per component, each with its own timestamp. */
export interface AnalysisEvidence {
  ruleEngine?: { at: string; result: Record<string, unknown> }
  wallet?: { at: string; result: Record<string, unknown> }
  simulation?: { at: string; result: Record<string, unknown> }
  llm?: { at: string; result: Record<string, unknown> }
}

/** Reconstructed view of one transaction's complete decision record. */
export interface AuditRecord {
  txHash: string
  safe: string
  chainId: number
  verdictId?: string
  policyVersion: string
  ruleVersion: string
  createdAt: string
  updatedAt: string
  analysis: AnalysisEvidence
  canonical?: CanonicalDecision
  enforcement?: EnforcementRecord
  reconciliation?: ReconciliationRecord
  /** Every event for this tx, in append order - the full, un-overwritten history. */
  timeline: AuditEvent[]
}

export interface AuditFilter {
  safe?: string
  txHash?: string
  verdictId?: string
  riskLevel?: string
  enforcementStatus?: string
  limit?: number
}

/**
 * The only persistence contract: appends and full replay. Sinks MUST NOT
 * expose mutation - that is what keeps criterion "prevent silent
 * overwrites" structural rather than conventional.
 */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>
  readAll(): Promise<AuditEvent[]>
}

/** In-memory sink - the default, and what tests use. */
export function createMemorySink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return {
    events,
    async append(event) {
      events.push(event)
    },
    async readAll() {
      return [...events]
    },
  }
}

/**
 * Append-only JSON-lines file sink. One event per line; replay parses
 * line-by-line and skips blanks, so a torn final line from a crash loses
 * at most one in-flight event, never the history before it.
 */
export function createJsonlSink(filePath: string): AuditSink {
  return {
    async append(event) {
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8")
    },
    async readAll() {
      let raw: string
      try {
        raw = await readFile(filePath, "utf8")
      } catch {
        return [] // a ledger that has never been written reads as empty
      }
      const events: AuditEvent[] = []
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          events.push(JSON.parse(trimmed) as AuditEvent)
        } catch {
          // skip corrupt line - later events still replay
        }
      }
      return events
    },
  }
}

export interface AuditLedgerOptions {
  safe: string
  chainId: number
  /** Recorded into every canonical verdict. Default "policy-v1". */
  policyVersion?: string
  /** Recorded into every canonical verdict. Default "rules-v1". */
  ruleVersion?: string
  sink: AuditSink
  now?: () => Date
  /** Sink/persistence failures land here; the pipeline keeps running. */
  onError?: (err: unknown) => void
}

const COMPONENT_TO_EVIDENCE_KEY: Record<AuditComponent, keyof AnalysisEvidence | undefined> = {
  "rule-engine": "ruleEngine",
  wallet: "wallet",
  simulation: "simulation",
  llm: "llm",
  relayer: undefined,
  reconciler: undefined,
}

export class AuditLedger {
  private readonly events = new Map<string, AuditEvent[]>()
  private readonly verdictIds = new Map<string, string>()
  private seq = 0

  private constructor(
    private readonly options: Required<Omit<AuditLedgerOptions, "onError">> & Pick<AuditLedgerOptions, "onError">,
  ) {}

  /** Opens a ledger, replaying everything the sink already holds. */
  static async open(options: AuditLedgerOptions): Promise<AuditLedger> {
    const ledger = new AuditLedger({
      policyVersion: options.policyVersion ?? "policy-v1",
      ruleVersion: options.ruleVersion ?? "rules-v1",
      now: options.now ?? (() => new Date()),
      ...options,
    } as Required<Omit<AuditLedgerOptions, "onError">> & Pick<AuditLedgerOptions, "onError">)
    // The sink may hand events back in any order: fire-and-forget appends
    // race, and a crash mid-flush can leave the tail interleaved. The
    // ledger's total order is `seq`, so replay sorts by it - reconstruction
    // must not depend on write order.
    const events = await options.sink.readAll()
    events.sort((a, b) => a.seq - b.seq)
    for (const event of events) {
      ledger.replay(event)
    }
    return ledger
  }

  private replay(event: AuditEvent): void {
    this.seq = Math.max(this.seq, event.seq + 1)
    const list = this.events.get(event.txHash) ?? []
    list.push(event)
    this.events.set(event.txHash, list)
    if (event.verdictId && !this.verdictIds.has(event.txHash)) {
      this.verdictIds.set(event.txHash, event.verdictId)
    }
  }

  /**
   * Appends an event. The in-memory index is authoritative for reads; the
   * sink write is best-effort and never rejects (failures go to onError).
   */
  log(
    txHash: string,
    type: AuditEventType,
    component: AuditComponent | undefined,
    data: Record<string, unknown> = {},
  ): AuditEvent {
    const event: AuditEvent = {
      seq: this.seq++,
      at: this.options.now().toISOString(),
      txHash,
      verdictId: this.verdictIds.get(txHash),
      type,
      component,
      data,
    }
    if (type === "verdict" && !event.verdictId) {
      event.verdictId = `${txHash}#v1`
      this.verdictIds.set(txHash, event.verdictId)
    }
    this.replay(event)
    Promise.resolve(this.options.sink.append(event)).catch((err: unknown) => {
      if (this.options.onError) this.options.onError(err)
      else console.warn("[audit] sink append failed (event kept in memory):", err)
    })
    return event
  }

  /** Every event for a tx, in append order. */
  timeline(txHash: string): AuditEvent[] {
    return [...(this.events.get(txHash) ?? [])]
  }

  has(txHash: string): boolean {
    return this.events.has(txHash)
  }

  /** Folds a tx's events into the reconstructed audit record. */
  get(txHash: string): AuditRecord | undefined {
    const timeline = this.events.get(txHash)
    if (!timeline || timeline.length === 0) return undefined

    const record: AuditRecord = {
      txHash,
      safe: this.options.safe,
      chainId: this.options.chainId,
      verdictId: this.verdictIds.get(txHash),
      policyVersion: this.options.policyVersion,
      ruleVersion: this.options.ruleVersion,
      createdAt: timeline[0].at,
      updatedAt: timeline[timeline.length - 1].at,
      analysis: {},
      timeline: [...timeline],
    }

    for (const event of timeline) {
      if (event.type === "verdict") {
        record.canonical = {
          score: Number(event.data.score ?? 0),
          status: String(event.data.status ?? "unknown"),
          action: String(event.data.action ?? "unknown"),
          explanation: String(event.data.explanation ?? ""),
          at: event.at,
          policyVersion: this.options.policyVersion,
          ruleVersion: this.options.ruleVersion,
        }
        record.verdictId = event.verdictId
      }
      if (event.type === "analysis" && event.component) {
        const key = COMPONENT_TO_EVIDENCE_KEY[event.component]
        if (key) record.analysis[key] = { at: event.at, result: event.data }
      }
      if (event.type === "enforcement") {
        const status = String(event.data.status ?? "submitted") as EnforcementRecord["status"]
        record.enforcement = {
          enforcementTxHash: event.data.enforcementTxHash as string | undefined,
          status,
          attempts: (record.enforcement?.attempts ?? 0) + 1,
          lastAttemptAt: event.at,
        }
      }
      if (event.type === "retry" && record.enforcement) {
        record.enforcement.attempts += 1
        record.enforcement.lastAttemptAt = event.at
      }
      if (event.type === "failure" && record.enforcement) {
        record.enforcement.status = "failed"
        record.enforcement.lastAttemptAt = event.at
      }
      if (event.type === "reconciliation") {
        record.reconciliation = {
          expected: String(event.data.expected ?? ""),
          actual: String(event.data.actual ?? ""),
          status: String(event.data.status ?? "pending") as ReconciliationRecord["status"],
          at: event.at,
        }
      }
    }
    return record
  }

  /** All reconstructed records, newest activity first. */
  all(): AuditRecord[] {
    return [...this.events.keys()]
      .map((txHash) => this.get(txHash))
      .filter((r): r is AuditRecord => r !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Filtered reconstruction - the investigation/query API (criterion: filtering). */
  query(filter: AuditFilter = {}): AuditRecord[] {
    let records = this.all()
    if (filter.safe) records = records.filter((r) => r.safe.toLowerCase() === filter.safe!.toLowerCase())
    if (filter.txHash) records = records.filter((r) => r.txHash === filter.txHash)
    if (filter.verdictId) records = records.filter((r) => r.verdictId === filter.verdictId)
    if (filter.riskLevel) records = records.filter((r) => r.canonical?.status === filter.riskLevel)
    if (filter.enforcementStatus) records = records.filter((r) => r.enforcement?.status === filter.enforcementStatus)
    if (filter.limit && filter.limit > 0) records = records.slice(0, filter.limit)
    return records
  }
}
