/**
 * Job workers (issue #55): the claim -> run -> complete/fail loop.
 *
 * A worker is one process (or test) that repeatedly:
 *
 *   1. sweeps for jobs abandoned by crashed workers (recoverAbandoned),
 *   2. claims the oldest due job it can run - exclusively, so two workers
 *      can never process the same job (and duplicate delivery of an event
 *      can never produce duplicate results: there is only one job per
 *      txHash + analysisType, and only one claim succeeds),
 *   3. runs the analysis under a per-job timeout that aborts the task,
 *   4. records success or routes the failure into the engine's
 *      retry/dead-letter machinery.
 *
 * Tasks receive the job plus an AbortSignal and must return
 * JSON-serializable results; they may throw `NonRetryableError` to skip
 * retrying (a permanent failure goes straight to FAILED, not the retry
 * queue).
 */

import { randomUUID } from "node:crypto"

import { type AnalysisType, type Job } from "./jobTypes.js"
import { type JobEngine, NonRetryableError } from "./jobEngine.js"

export interface JobRunResult {
  /** Where the full result lives (audit record id, file, ...). */
  resultRef: string
  /** Verdict produced by this analysis, for correlation. */
  verdictId?: string | null
  /** Inline result when small enough to keep. */
  result?: unknown
}

export type JobTask = (job: Job, signal: AbortSignal) => Promise<JobRunResult>

export type JobTaskRegistry = Partial<Record<AnalysisType, JobTask>>

/** Raised when a task exceeds its job's timeout budget. */
export class JobTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobTimeoutError"
  }
}

export interface JobWorker {
  /** One full cycle: sweep, claim, run, settle. Returns jobs processed. */
  runOnce(): Promise<number>
  /** Polls runOnce forever; returns a stop handle. */
  start(pollIntervalMs?: number): () => void
}

export interface JobWorkerOptions {
  /** Fallback execution budget for jobs enqueued without their own. */
  timeoutMs?: number
}

export function createJobWorker(
  engine: JobEngine,
  tasks: JobTaskRegistry,
  workerId: string = `worker-${randomUUID().slice(0, 8)}`,
  options: JobWorkerOptions = {},
): JobWorker {
  async function runJob(job: Job): Promise<void> {
    const task = tasks[job.analysisType]
    if (!task) {
      // No handler for this analysis type is a permanent condition - fail
      // loudly and immediately instead of burning the retry budget.
      engine.fail(job.id, workerId, new NonRetryableError(`no worker task registered for ${job.analysisType}`))
      return
    }

    const timeoutMs = job.timeoutMs ?? options.timeoutMs
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new JobTimeoutError(`job ${job.id} exceeded its ${timeoutMs}ms timeout`))
      }, timeoutMs)
    })

    try {
      const outcome = await Promise.race([task(job, controller.signal), timedOut])
      engine.complete(job.id, workerId, outcome)
    } catch (error) {
      engine.fail(job.id, workerId, error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function runOnce(): Promise<number> {
    engine.recoverAbandoned()
    const job = engine.claim(workerId)
    if (!job) return 0
    await runJob(job)
    return 1
  }

  return {
    runOnce,
    start(pollIntervalMs = 1_000): () => void {
      const handle = setInterval(() => {
        runOnce().catch((error: unknown) => {
          console.error(`[job-worker ${workerId}] poll failed:`, error)
        })
      }, pollIntervalMs)
      return () => clearInterval(handle)
    },
  }
}
