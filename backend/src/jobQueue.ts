/**
 * Durable job-processing infrastructure for the risk-analysis pipeline.
 *
 * Issue #55: guarantees Safe transaction events are not lost, duplicated,
 * or permanently stuck when individual analysis components fail.
 *
 * Design goals:
 *   - In-memory store (swap for SQLite/Redis in production)
 *   - Exponential backoff retries with configurable limits
 *   - Dead-letter queue for permanently failed jobs
 *   - Timeout detection for abandoned jobs
 *   - Idempotent claiming via optimistic CAS (compare-and-swap)
 *   - Full audit trail: attempt count, errors, timestamps, worker IDs
 */

import { randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum JobStatus {
  QUEUED = "QUEUED",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  RETRYING = "RETRYING",
  FAILED = "FAILED",
  DEAD_LETTER = "DEAD_LETTER",
}

export enum AnalysisType {
  RULES = "RULES",
  WALLET_RISK = "WALLET_RISK",
  SIMULATION = "SIMULATION",
  LLM = "LLM",
}

export interface Job {
  id: string
  /** The Safe transaction hash this job is analysing. */
  txHash: string
  analysisType: AnalysisType
  status: JobStatus
  attemptCount: number
  maxAttempts: number
  /** Worker that currently owns this job (null when not processing). */
  workerId: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  lastError: string | null
  /** Exponential backoff: milliseconds until the next retry is eligible. */
  nextRetryAt: number | null
  /** Idempotency key: derived from (txHash, analysisType). Duplicate events
   *  with the same key silently return the existing job. */
  idempotencyKey: string
  /** Freeform result payload stored on success. */
  result: unknown
  /** Ordered history of every attempt (for audit). */
  attempts: JobAttempt[]
}

export interface JobAttempt {
  attemptNumber: number
  workerId: string
  startedAt: number
  completedAt: number | null
  error: string | null
  durationMs: number | null
}

export interface CreateJobInput {
  txHash: string
  analysisType: AnalysisType
  maxAttempts?: number
}

export interface JobStore {
  /** Insert a new job. Returns the existing job if an idempotent duplicate. */
  create(input: CreateJobInput): Job
  /** CAS claim: only succeeds if status is QUEUED/RETRYING and workerId is null. */
  claim(jobId: string, workerId: string): Job | null
  /** Mark a job as completed with a result payload. */
  complete(jobId: string, result: unknown): Job
  /** Mark a job as failed; may transition to RETRYING or DEAD_LETTER. */
  fail(jobId: string, error: string): Job
  /** Read a job by ID. */
  get(jobId: string): Job | null
  /** Read all jobs for a given txHash (for the audit trail). */
  getByTxHash(txHash: string): Job[]
  /** Jobs whose status is QUEUED or RETRYING and nextRetryAt <= now. */
  dueJobs(): Job[]
  /** Jobs stuck in PROCESSING longer than timeoutMs. */
  abandonedJobs(timeoutMs: number): Job[]
  /** Replay a dead-lettered job back to QUEUED. */
  replay(jobId: string): Job | null
  /** All jobs, optionally filtered by status. */
  list(status?: JobStatus): Job[]
  /** Summary counts per status. */
  stats(): Record<JobStatus, number>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idempotencyKey(txHash: string, analysisType: AnalysisType): string {
  return `${txHash}:${analysisType}`
}

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 60_000

/** Exponential backoff: base * 2^attempt, capped. Jitter added by caller if desired. */
export function backoffMs(attempt: number): number {
  const delay = BASE_DELAY_MS * 2 ** attempt
  return Math.min(delay, MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// In-memory JobStore (production would swap for SQLite / Redis)
// ---------------------------------------------------------------------------

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>()

  create(input: CreateJobInput): Job {
    const key = idempotencyKey(input.txHash, input.analysisType)
    // Idempotent: return existing job if one already exists for this pair.
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey === key) return job
    }

    const maxAttempts = input.maxAttempts ?? 3
    const job: Job = {
      id: randomUUID(),
      txHash: input.txHash,
      analysisType: input.analysisType,
      status: JobStatus.QUEUED,
      attemptCount: 0,
      maxAttempts,
      workerId: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
      idempotencyKey: key,
      result: null,
      attempts: [],
    }
    this.jobs.set(job.id, job)
    return job
  }

  claim(jobId: string, workerId: string): Job | null {
    const job = this.jobs.get(jobId)
    if (!job) return null
    // Only QUEUED or RETRYING jobs with no current worker can be claimed.
    if (
      (job.status !== JobStatus.QUEUED && job.status !== JobStatus.RETRYING) ||
      job.workerId !== null
    ) {
      return null
    }
    // If the job is RETRYING, check that the backoff has elapsed.
    if (job.status === JobStatus.RETRYING && job.nextRetryAt !== null && job.nextRetryAt > Date.now()) {
      return null
    }
    job.status = JobStatus.PROCESSING
    job.workerId = workerId
    job.startedAt = Date.now()
    job.attemptCount += 1
    job.attempts.push({
      attemptNumber: job.attemptCount,
      workerId,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      durationMs: null,
    })
    return job
  }

  complete(jobId: string, result: unknown): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job ${jobId} not found`)
    job.status = JobStatus.COMPLETED
    job.completedAt = Date.now()
    job.workerId = null
    job.result = result
    const lastAttempt = job.attempts[job.attempts.length - 1]
    if (lastAttempt) {
      lastAttempt.completedAt = Date.now()
      lastAttempt.durationMs = lastAttempt.completedAt - lastAttempt.startedAt
    }
    return job
  }

  fail(jobId: string, error: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job ${jobId} not found`)
    job.lastError = error
    job.workerId = null
    const lastAttempt = job.attempts[job.attempts.length - 1]
    if (lastAttempt) {
      lastAttempt.completedAt = Date.now()
      lastAttempt.durationMs = lastAttempt.completedAt - lastAttempt.startedAt
      lastAttempt.error = error
    }

    if (job.attemptCount >= job.maxAttempts) {
      job.status = JobStatus.DEAD_LETTER
      job.completedAt = Date.now()
    } else {
      job.status = JobStatus.RETRYING
      job.nextRetryAt = Date.now() + backoffMs(job.attemptCount)
    }
    return job
  }

  get(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null
  }

  getByTxHash(txHash: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.txHash === txHash)
  }

  dueJobs(): Job[] {
    const now = Date.now()
    return [...this.jobs.values()].filter(
      (j) =>
        (j.status === JobStatus.QUEUED || j.status === JobStatus.RETRYING) &&
        j.workerId === null &&
        (j.nextRetryAt === null || j.nextRetryAt <= now),
    )
  }

  abandonedJobs(timeoutMs: number): Job[] {
    const cutoff = Date.now() - timeoutMs
    return [...this.jobs.values()].filter(
      (j) => j.status === JobStatus.PROCESSING && j.startedAt !== null && j.startedAt < cutoff,
    )
  }

  replay(jobId: string): Job | null {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== JobStatus.DEAD_LETTER) return null
    job.status = JobStatus.QUEUED
    job.workerId = null
    job.nextRetryAt = null
    job.completedAt = null
    // Reset attempt count so the replayed job gets a fresh set of retries.
    job.attemptCount = 0
    return job
  }

  list(status?: JobStatus): Job[] {
    const all = [...this.jobs.values()]
    return status ? all.filter((j) => j.status === status) : all
  }

  stats(): Record<JobStatus, number> {
    const counts = {} as Record<JobStatus, number>
    for (const s of Object.values(JobStatus)) counts[s as JobStatus] = 0
    for (const job of this.jobs.values()) counts[job.status]++
    return counts
  }
}

// ---------------------------------------------------------------------------
// JobRunner — the event loop that picks up due jobs, runs them, handles
// results and failures.
// ---------------------------------------------------------------------------

export type WorkerFn = (job: Job) => Promise<unknown>

export interface JobRunnerConfig {
  /** How often (ms) to poll for due jobs. */
  pollIntervalMs?: number
  /** How long (ms) a job can be PROCESSING before it's considered abandoned. */
  timeoutMs?: number
  /** Inject for testing. Defaults to Date.now(). */
  now?: () => number
}

export class JobRunner {
  private interval: ReturnType<typeof setInterval> | null = null
  private readonly workers = new Map<AnalysisType, WorkerFn>()

  constructor(
    private readonly store: JobStore,
    private readonly config: JobRunnerConfig = {},
  ) {}

  /** Register a worker function for a specific analysis type. */
  registerWorker(type: AnalysisType, fn: WorkerFn): void {
    this.workers.set(type, fn)
  }

  /** Start the polling loop. */
  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      this.tick().catch((err) => console.error("[job-runner] tick failed:", err))
    }, this.config.pollIntervalMs ?? 1_000)
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  /** Single poll cycle: recover abandoned → claim due → process. */
  async tick(): Promise<void> {
    // 1. Recover abandoned jobs.
    const timeoutMs = this.config.timeoutMs ?? 30_000
    const abandoned = this.store.abandonedJobs(timeoutMs)
    for (const job of abandoned) {
      this.store.fail(job.id, `Worker ${job.workerId} timed out after ${timeoutMs}ms`)
    }

    // 2. Pick up due jobs and process them.
    const due = this.store.dueJobs()
    for (const job of due) {
      const workerId = `worker-${randomUUID().slice(0, 8)}`
      const claimed = this.store.claim(job.id, workerId)
      if (!claimed) continue // Another runner beat us to it.

      const fn = this.workers.get(job.analysisType)
      if (!fn) {
        this.store.fail(job.id, `No worker registered for ${job.analysisType}`)
        continue
      }

      // Fire and forget — the tick loop is non-blocking per job.
      this.processJob(claimed, fn).catch((err) => {
        console.error(`[job-runner] unexpected error processing job ${claimed.id}:`, err)
      })
    }
  }

  private async processJob(job: Job, fn: WorkerFn): Promise<void> {
    try {
      const result = await fn(job)
      this.store.complete(job.id, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.fail(job.id, message)
    }
  }

  /** Manually process a single job (useful for tests and one-off retries). */
  async processOne(jobId: string): Promise<Job | null> {
    const job = this.store.get(jobId)
    if (!job) return null
    const fn = this.workers.get(job.analysisType)
    if (!fn) return null
    const workerId = `manual-${randomUUID().slice(0, 8)}`
    const claimed = this.store.claim(job.id, workerId)
    if (!claimed) return null
    await this.processJob(claimed, fn)
    return this.store.get(jobId)
  }
}

// ---------------------------------------------------------------------------
// Recovery — standalone function to replay dead-lettered jobs
// ---------------------------------------------------------------------------

/**
 * Replays all dead-lettered jobs for a given Safe transaction hash back to
 * QUEUED status so they can be re-processed. Returns the replayed jobs.
 */
export function replayDeadLetters(store: JobStore, txHash: string): Job[] {
  const jobs = store.getByTxHash(txHash)
  const replayed: Job[] = []
  for (const job of jobs) {
    if (job.status === JobStatus.DEAD_LETTER) {
      const result = store.replay(job.id)
      if (result) replayed.push(result)
    }
  }
  return replayed
}
