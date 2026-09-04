/**
 * Job engine (issue #55): the state machine every transition goes through.
 *
 * One engine owns one store and answers for it - `enqueue` persists the job
 * before returning, `claim` hands out exclusive leases, and every other
 * transition is a guarded move between states that throws if you try an
 * impossible one (completing a job you don't hold, claiming a job that is
 * already PROCESSING, replaying a healthy job, ...). Failures are never
 * dropped: they either schedule a bounded exponential-backoff retry, land
 * in the dead-letter queue, or - when the error is known to be permanent -
 * fail the job outright.
 *
 * Every transition is *functional*: the previous snapshot is never mutated,
 * a new one is appended instead. That keeps each event in the store a true,
 * immutable picture of the job at that moment - which is exactly what makes
 * the log a trustworthy audit trail (issue #55: "persist failure reasons
 * and complete retry history", "completed jobs remain traceable").
 *
 * Concurrency: within one process (or one file log) a claim is atomic
 * because the status flip happens in one synchronous store append. Two
 * workers racing for the same job: the first flips QUEUED -> PROCESSING,
 * the second no longer sees a claimable job. True multi-process claiming
 * over one log would need a distributed compare-and-set store - the store
 * interface is the seam where that would slot in.
 */

import { randomUUID } from "node:crypto"

import {
  type AnalysisType,
  type Job,
  type JobEvent,
  type JobStatus,
  type RetryPolicy,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY_POLICY,
  nextRetryAtMs,
} from "./jobTypes.js"
import { type JobStore, createInMemoryJobStore } from "./jobStore.js"

export class JobStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobStateError"
  }
}

/** A failure that retrying will never fix (bad input, missing handler,
 * permanent schema mismatch). Workers throw this to skip straight to
 * FAILED instead of burning retries. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NonRetryableError"
  }
}

export interface EnqueueInput {
  /** Safe transaction hash this analysis belongs to (correlation). */
  txHash: string
  analysisType: AnalysisType
  /** Verdict the parent workflow already knows about, if any. */
  verdictId?: string | null
  /** Per-job execution budget; defaults to the engine's default. */
  timeoutMs?: number
}

export interface JobEngineOptions {
  retry?: RetryPolicy
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number
  /** How long a claim is held before a crashed worker forfeits it. */
  leaseMs?: number
  /** Default execution budget for jobs enqueued without one. */
  defaultTimeoutMs?: number
  /** Injectable id generator for deterministic tests. */
  idFactory?: () => string
}

export interface JobQuery {
  status?: JobStatus
  analysisType?: AnalysisType
  txHash?: string
}

export class JobEngine {
  private readonly retry: Required<RetryPolicy>
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly defaultTimeoutMs: number
  private readonly idFactory: () => string

  constructor(
    private readonly store: JobStore = createInMemoryJobStore(),
    options: JobEngineOptions = {},
  ) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry }
    this.now = options.now ?? (() => Date.now())
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    this.idFactory = options.idFactory ?? (() => randomUUID())
  }

  /** The store this engine persists to (for status reads and audits). */
  get log(): JobStore {
    return this.store
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  getJob(jobId: string): Job | undefined {
    return this.store.readJobs().find((job) => job.id === jobId)
  }

  /** Filtered, oldest-first view for the status endpoint and tests. */
  listJobs(query: JobQuery = {}): Job[] {
    return this.store
      .readJobs()
      .filter((job) => {
        if (query.status !== undefined && job.status !== query.status) return false
        if (query.analysisType !== undefined && job.analysisType !== query.analysisType) return false
        if (query.txHash !== undefined && job.txHash !== query.txHash) return false
        return true
      })
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Audit trail for one job (its complete event history). */
  eventsFor(jobId: string): JobEvent[] {
    return this.store.readEvents(jobId)
  }

  // ------------------------------------------------------------------
  // Enqueue
  // ------------------------------------------------------------------

  /** Persists a job before returning. Idempotent per (txHash, analysisType):
   * duplicate delivery of the same transaction event returns the existing
   * job instead of creating a second analysis - one of the two ways the
   * system prevents duplicate results (the other is the exclusive claim). */
  enqueue(input: EnqueueInput): Job {
    const existing = this.store.readJobs().find(
      (job) => job.txHash === input.txHash && job.analysisType === input.analysisType,
    )
    if (existing) return existing

    const job: Job = {
      id: this.idFactory(),
      txHash: input.txHash,
      analysisType: input.analysisType,
      status: "QUEUED",
      attemptCount: 0,
      workerId: null,
      createdAt: this.now(),
      startedAt: null,
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      leaseExpiresAt: null,
      verdictId: input.verdictId ?? null,
      resultRef: null,
      result: null,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      retryHistory: [],
    }
    this.store.append({ jobId: job.id, at: this.now(), type: "created", job })
    return job
  }

  // ------------------------------------------------------------------
  // Claiming (exclusive lease)
  // ------------------------------------------------------------------

  /** Claims the oldest due job - QUEUED, or RETRYING whose backoff has
   * elapsed. Returns null when nothing is due. `analysisType` narrows the
   * claim so a dedicated rules worker never eats a simulation job. */
  claim(workerId: string, analysisType?: AnalysisType): Job | null {
    const now = this.now()
    const due = this.store
      .readJobs()
      .filter((job) => {
        if (analysisType !== undefined && job.analysisType !== analysisType) return false
        if (job.status === "QUEUED") return true
        return job.status === "RETRYING" && (job.nextRetryAt ?? 0) <= now
      })
      .sort((a, b) => a.createdAt - b.createdAt)
    if (due.length === 0) return null

    const job = due[0]
    const claimed: Job = {
      ...job,
      attemptCount: job.attemptCount + 1,
      status: "PROCESSING",
      workerId,
      startedAt: now,
      nextRetryAt: null,
      leaseExpiresAt: now + this.leaseMs,
      lastError: null,
    }
    this.store.append({
      jobId: job.id,
      at: now,
      type: "claimed",
      attempt: claimed.attemptCount,
      job: claimed,
    })
    return claimed
  }

  // ------------------------------------------------------------------
  // Completion & failure
  // ------------------------------------------------------------------

  /** Records a successful run. Only the worker holding the lease may do
   * this; the result and its correlation ids ride on the event, so a
   * completed job stays traceable through the audit log. */
  complete(
    jobId: string,
    workerId: string,
    outcome: { resultRef?: string; verdictId?: string | null; result?: unknown } = {},
  ): Job {
    const job = this.mustGet(jobId)
    if (job.status !== "PROCESSING" || job.workerId !== workerId) {
      throw new JobStateError(
        `job ${jobId} is ${job.status} (held by ${String(job.workerId)}); cannot complete as ${workerId}`,
      )
    }
    const now = this.now()
    const completed: Job = {
      ...job,
      status: "COMPLETED",
      completedAt: now,
      workerId: null,
      leaseExpiresAt: null,
      ...(outcome.resultRef !== undefined ? { resultRef: outcome.resultRef } : {}),
      ...(outcome.verdictId !== undefined ? { verdictId: outcome.verdictId } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    }
    this.store.append({ jobId, at: now, type: "completed", job: completed })
    return completed
  }

  /** Records a failure. Retryable failures with attempts left move to
   * RETRYING with exponential backoff; exhausted attempts go to the
   * dead-letter queue; `NonRetryableError` skips straight to FAILED. The
   * reason and attempt number are always persisted. */
  fail(jobId: string, workerId: string, error: unknown, options: { retryable?: boolean } = {}): Job {
    const job = this.mustGet(jobId)
    if (job.status !== "PROCESSING" || job.workerId !== workerId) {
      throw new JobStateError(
        `job ${jobId} is ${job.status} (held by ${String(job.workerId)}); cannot fail as ${workerId}`,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    const retryable = options.retryable ?? !(error instanceof NonRetryableError)
    const now = this.now()
    const attempt = job.attemptCount
    const failed: Job = {
      ...job,
      workerId: null,
      leaseExpiresAt: null,
      lastError: message,
      retryHistory: [...job.retryHistory, { at: now, attempt, error: message }],
    }

    if (!retryable) {
      failed.status = "FAILED"
      this.store.append({ jobId, at: now, type: "cancelled", error: message, job: failed })
      return failed
    }
    if (attempt >= this.retry.maxAttempts) {
      failed.status = "DEAD_LETTER"
      this.store.append({ jobId, at: now, type: "dead_lettered", error: message, job: failed })
      return failed
    }
    failed.status = "RETRYING"
    failed.nextRetryAt = nextRetryAtMs(attempt, this.retry, now)
    this.store.append({ jobId, at: now, type: "retrying", error: message, attempt, job: failed })
    return failed
  }

  /** Operator cancellation. Only queued, retrying or in-flight jobs can be
   * cancelled (cancelling a claimed job frees its lease). Cancelled jobs
   * are FAILED with a reason and can be replayed like dead letters. */
  cancel(jobId: string, reason = "cancelled by operator"): Job {
    const job = this.mustGet(jobId)
    if (job.status !== "QUEUED" && job.status !== "RETRYING" && job.status !== "PROCESSING") {
      throw new JobStateError(`job ${jobId} is ${job.status} and cannot be cancelled`)
    }
    const now = this.now()
    const cancelled: Job = {
      ...job,
      status: "FAILED",
      workerId: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      lastError: reason,
      retryHistory: [...job.retryHistory, { at: now, attempt: job.attemptCount, error: reason }],
    }
    this.store.append({ jobId, at: now, type: "cancelled", error: reason, job: cancelled })
    return cancelled
  }

  // ------------------------------------------------------------------
  // Crash recovery & replay
  // ------------------------------------------------------------------

  /** Recovers jobs abandoned by crashed workers: any PROCESSING job whose
   * lease has expired is failed through the normal retry path, so a job
   * interrupted mid-run is retried or dead-lettered - never stuck forever.
   * A live worker calls this on every poll; an operator (or cron) can also
   * call it directly. Returns the jobs it recovered. */
  recoverAbandoned(now: number = this.now()): Job[] {
    const abandoned = this.store
      .readJobs()
      .filter((job) => job.status === "PROCESSING" && (job.leaseExpiresAt ?? 0) <= now)
    for (const job of abandoned) {
      this.fail(job.id, job.workerId ?? "unknown", `worker ${job.workerId ?? "unknown"} crashed before finishing`)
    }
    return abandoned
  }

  /** Replays a dead-lettered or failed job: back to QUEUED with its attempt
   * counter reset. The retry history is deliberately kept - the full story
   * survives replay. This is the manual/automatic recovery mechanism for
   * the dead-letter queue. */
  replay(jobId: string): Job {
    const job = this.mustGet(jobId)
    if (job.status !== "DEAD_LETTER" && job.status !== "FAILED") {
      throw new JobStateError(`job ${jobId} is ${job.status}; only dead-lettered or failed jobs can be replayed`)
    }
    const replayed: Job = {
      ...job,
      status: "QUEUED",
      attemptCount: 0,
      workerId: null,
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      leaseExpiresAt: null,
      lastError: null,
    }
    this.store.append({ jobId, at: this.now(), type: "replayed", job: replayed })
    return replayed
  }

  private mustGet(jobId: string): Job {
    const job = this.getJob(jobId)
    if (!job) throw new JobStateError(`no job with id ${jobId}`)
    return job
  }
}
