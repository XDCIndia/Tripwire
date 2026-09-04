/**
 * Durable job queue domain model (issue #55).
 *
 * The risk pipeline fans one Safe transaction event out into four
 * independent analyses - rules, wallet risk, simulation, and LLM judgment -
 * each of which can time out, crash, rate-limit or vanish. This module is
 * the vocabulary the whole job layer shares: what a job is, what states it
 * can be in, and how retries are priced. Everything stays plain JSON so a
 * job (and its full retry history) can be persisted, shipped to an audit
 * ledger, or replayed years later without a schema migration.
 *
 * State machine (transitions are enforced by the engine, not here):
 *
 *   enqueue ─► QUEUED ─claim─► PROCESSING ─complete─► COMPLETED
 *                │  ▲              │
 *                │  │              ├─fail (attempts left)──► RETRYING ──► (due) ─► PROCESSING
 *                │  └────replay────┼─fail (no attempts)────► DEAD_LETTER ─┘
 *                │                 └─cancel / non-retryable─► FAILED
 *                └────cancel───────────────────────────────────┘
 *
 * A job that never leaves PROCESSING (its worker crashed) is *recovered*,
 * not lost: once its lease expires the engine fails it and the normal
 * retry/DLQ machinery takes over.
 */

/** The four independent analyses the pipeline runs per transaction. */
export const ANALYSIS_TYPES = ["RULES", "WALLET_RISK", "SIMULATION", "LLM"] as const
export type AnalysisType = (typeof ANALYSIS_TYPES)[number]

export const JOB_STATUSES = ["QUEUED", "PROCESSING", "RETRYING", "COMPLETED", "FAILED", "DEAD_LETTER"] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/** One entry in a job's permanent retry history. */
export interface RetryRecord {
  /** When the attempt failed, epoch ms. */
  at: number
  /** Which attempt this was (1-based). */
  attempt: number
  /** Why it failed. Never dropped, so the full story survives to DLQ. */
  error: string
}

/** A risk-analysis job. Field names deliberately mirror the issue's layout
 * (Job ID, Transaction ID, Analysis Type, Status, Attempt Count, Worker ID,
 * Created/Started/Completed At, Last Error, Next Retry At) plus the lease
 * bookkeeping crash recovery needs and the correlation fields the verdict
 * and audit systems key on. */
export interface Job {
  id: string
  /** The Safe transaction this analysis belongs to (correlation). */
  txHash: string
  analysisType: AnalysisType
  status: JobStatus
  /** Number of claim attempts so far (1 = first try). */
  attemptCount: number
  /** The worker currently holding the lease, if any. */
  workerId: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  /** Human-readable reason for the last failure (null while healthy). */
  lastError: string | null
  /** Epoch ms the next retry may be claimed (null while not retrying). */
  nextRetryAt: number | null
  /** Lease expiry: when PROCESSING, the claim is forfeit after this. */
  leaseExpiresAt: number | null
  /** Verdict the completed analysis produced (correlation with the
   * RiskRegistry verdict / audit ledger). */
  verdictId: string | null
  /** Where the full result lives (audit record id, file, ...). */
  resultRef: string | null
  /** The result itself when it is small enough to keep inline. */
  result: unknown
  /** Per-job execution budget in ms; exceeded work is aborted & retried. */
  timeoutMs: number
  /** Every failure, oldest first - preserved across retries and replay. */
  retryHistory: RetryRecord[]
}

/** Append-only audit events for a job. The store persists these; the live
 * state is always derived from them, which is what makes crash recovery
 * (replay the log) and audit traceability the same mechanism. */
export type JobEventType =
  | "created"
  | "claimed"
  | "completed"
  | "retrying"
  | "dead_lettered"
  | "cancelled"
  | "replayed"

export interface JobEvent {
  /** Store-assigned, monotonically increasing. */
  seq: number
  jobId: string
  at: number
  type: JobEventType
  /** The full job state after this transition - snapshots, not deltas. */
  job: Job
  /** Failure detail when the event is a failure/retry. */
  error?: string | null
  /** Which claim attempt an event refers to (claimed / retrying). */
  attempt?: number
}

/** Retry policy shared by the engine and every worker. Exponential backoff
 * with a hard ceiling: attempt n waits `baseDelayMs * backoffFactor^(n-1)`,
 * capped at `maxDelayMs`, and gives up entirely after `maxAttempts`. */
export interface RetryPolicy {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
}

export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
}

/** Default per-job execution budget and claim lease (ms). A lease must be
 * much longer than a job timeout: the timeout is how long a *hung task* may
 * run before the worker aborts it; the lease is how long a job may sit in
 * PROCESSING before a *crashed worker* forfeits it to recovery. */
export const DEFAULT_JOB_TIMEOUT_MS = 30_000
export const DEFAULT_LEASE_MS = 10 * 60_000

/** How long attempt `attempt` (1-based) waits before being claimable. */
export function retryDelayMs(attempt: number, policy: RetryPolicy = {}): number {
  const { baseDelayMs, maxDelayMs, backoffFactor } = { ...DEFAULT_RETRY_POLICY, ...policy }
  const capped = Math.min(baseDelayMs * backoffFactor ** Math.max(0, attempt - 1), maxDelayMs)
  return Math.max(0, Math.floor(capped))
}

export function nextRetryAtMs(attempt: number, policy: RetryPolicy, now: number): number {
  return now + retryDelayMs(attempt, policy)
}
