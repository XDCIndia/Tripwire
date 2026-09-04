/**
 * Durable job persistence (issue #55) - "persist jobs durably before
 * processing" and "completed jobs remain traceable" are the same mechanism
 * here: an append-only event log.
 *
 * Every state transition is appended as a full snapshot event and fsynced
 * before the engine reports success, so once `enqueue()` returns the job
 * cannot be lost to a crash. Live state is always *derived* from the log by
 * replaying it, which means:
 *
 *  - crash recovery is just "open the file and replay",
 *  - the log doubles as the permanent audit trail (every retry, failure,
 *    and dead-letter reason is an event, never overwritten),
 *  - a second process can rebuild the exact same view from the same file.
 *
 * Two implementations of one interface: `createInMemoryJobStore` for tests
 * and single-process use, `createFileJobStore` for durability. Both are
 * synchronous on purpose - the enqueue path must not return before the
 * event is on disk.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { dirname } from "node:path"

import { type Job, type JobEvent } from "./jobTypes.js"

export interface JobStore {
  /** Durably records one transition. Assigns the monotonic `seq`. */
  append(event: Omit<JobEvent, "seq">): JobEvent
  /** Live state of every job, derived from the log. */
  readJobs(): Job[]
  /** The full audit trail, optionally narrowed to one job. */
  readEvents(jobId?: string): JobEvent[]
  /** Number of log entries (seq of the next event). */
  size(): number
  /** Flushes and releases resources. A no-op for the in-memory store. */
  close(): void
}

export class JobStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobStoreError"
  }
}

/** Pure log replay shared by both implementations: the last snapshot event
 * per job wins, jobs keep their first-seen order. */
export function replayEvents(events: JobEvent[]): Job[] {
  const jobs = new Map<string, Job>()
  const order: string[] = []
  for (const event of events) {
    if (!jobs.has(event.jobId)) order.push(event.jobId)
    jobs.set(event.jobId, event.job)
  }
  return order.map((jobId) => jobs.get(jobId)!)
}

export function createInMemoryJobStore(): JobStore {
  const events: JobEvent[] = []
  return {
    append(event) {
      const stored: JobEvent = { seq: events.length + 1, ...event }
      events.push(stored)
      return stored
    },
    readJobs() {
      return replayEvents(events)
    },
    readEvents(jobId) {
      return jobId === undefined ? [...events] : events.filter((event) => event.jobId === jobId)
    },
    size() {
      return events.length
    },
    close() {
      /* nothing to flush */
    },
  }
}

/** Durable JSON-lines store. Each event is written synchronously and
 * fsynced before append returns. Opening an existing file replays it,
 * which both rebuilds state after a crash and refuses (loudly) to start
 * from an empty state while old events exist. */
export function createFileJobStore(filePath: string): JobStore {
  const events: JobEvent[] = []

  mkdirSync(dirname(filePath), { recursive: true })

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
  if (existing.length > 0) {
    for (const [index, raw] of existing.split("\n").entries()) {
      if (raw.trim() === "") continue
      let parsed: JobEvent
      try {
        parsed = JSON.parse(raw) as JobEvent
      } catch {
        throw new JobStoreError(`corrupt job log at ${filePath} line ${index + 1}`)
      }
      events.push(parsed)
    }
  }

  const fd = openSync(filePath, "a")

  return {
    append(event) {
      const stored: JobEvent = { seq: events.length + 1, ...event }
      const line = `${JSON.stringify(stored)}\n`
      writeSync(fd, line)
      fsyncSync(fd) // durable: return only once it is on disk
      events.push(stored)
      return stored
    },
    readJobs() {
      return replayEvents(events)
    },
    readEvents(jobId) {
      return jobId === undefined ? [...events] : events.filter((event) => event.jobId === jobId)
    },
    size() {
      return events.length
    },
    close() {
      fsyncSync(fd)
      closeSync(fd)
    },
  }
}
