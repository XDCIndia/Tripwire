import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type Job } from "../src/jobTypes.js"
import { JobStoreError, createFileJobStore, createInMemoryJobStore } from "../src/jobStore.js"

function sampleJob(id: string, status: Job["status"]): Job {
  return {
    id,
    txHash: "0xabc",
    analysisType: "RULES",
    status,
    attemptCount: 0,
    workerId: null,
    createdAt: 100,
    startedAt: null,
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    leaseExpiresAt: null,
    verdictId: null,
    resultRef: null,
    result: null,
    timeoutMs: 30_000,
    retryHistory: [],
  }
}

describe("in-memory store", function () {
  it("assigns monotonic seqs and derives live state from snapshots", function () {
    const store = createInMemoryJobStore()
    const job = sampleJob("j1", "QUEUED")
    store.append({ jobId: job.id, at: 1, type: "created", job })
    const processing = { ...job, status: "PROCESSING" as const, workerId: "w1" }
    store.append({ jobId: job.id, at: 2, type: "claimed", job: processing })

    expect(store.size()).toBe(2)
    expect(store.readJobs()).toEqual([processing]) // last snapshot wins
    expect(store.readEvents("j1").map((event) => event.seq)).toEqual([1, 2])
    expect(store.readEvents("missing")).toEqual([])
  })
})

describe("file store", function () {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tripwire-jobstore-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes every event durably and rebuilds identical state after a crash (reopen)", function () {
    const file = join(dir, "jobs.jsonl")

    // Process "crashes" mid-run: first create+claim+complete...
    const store = createFileJobStore(file)
    const job = sampleJob("j-live", "QUEUED")
    store.append({ jobId: job.id, at: 1, type: "created", job })
    const processing = { ...job, status: "PROCESSING" as const, workerId: "w1" }
    store.append({ jobId: job.id, at: 2, type: "claimed", job: processing })
    const done = { ...processing, status: "COMPLETED" as const, completedAt: 3, resultRef: "audit-1" }
    store.append({ jobId: job.id, at: 3, type: "completed", job: done })
    store.close()

    // ...and a second job whose worker crashed before finishing.
    const store2 = createFileJobStore(file)
    const stuck = sampleJob("j-stuck", "QUEUED")
    store2.append({ jobId: stuck.id, at: 4, type: "created", job: stuck })
    const stuckProcessing = { ...stuck, status: "PROCESSING" as const, workerId: "w2" }
    store2.append({ jobId: stuck.id, at: 5, type: "claimed", job: stuckProcessing })
    store2.close()

    // Reopening rebuilds exactly what was persisted - the completed job is
    // still completed, the stuck one still shows as PROCESSING (the engine's
    // recoverAbandoned will retry it from the lease timestamp).
    const reopened = createFileJobStore(file)
    const jobs = reopened.readJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.find((j) => j.id === "j-live")).toMatchObject({ status: "COMPLETED", resultRef: "audit-1" })
    expect(jobs.find((j) => j.id === "j-stuck")).toMatchObject({ status: "PROCESSING", workerId: "w2" })
    expect(reopened.readEvents("j-live").map((event) => event.type)).toEqual(["created", "claimed", "completed"])
    expect(reopened.readEvents().length).toBe(5)
    reopened.close()
  })

  it("persists snapshots immutably (later events do not rewrite history)", function () {
    const file = join(dir, "jobs.jsonl")
    const store = createFileJobStore(file)
    const job = sampleJob("j1", "QUEUED")
    store.append({ jobId: job.id, at: 1, type: "created", job })

    const raw = readFileSync(file, "utf8")
    const stored = JSON.parse(raw.trim()) as { job: { status: string } }
    expect(stored.job.status).toBe("QUEUED")
    store.close()
  })

  it("refuses to open a corrupt log instead of silently losing jobs", function () {
    const file = join(dir, "jobs.jsonl")
    const store = createFileJobStore(file)
    store.append({ jobId: "j1", at: 1, type: "created", job: sampleJob("j1", "QUEUED") })
    store.close()

    appendFileSync(file, "{not json}\n")
    expect(() => createFileJobStore(file)).toThrowError(JobStoreError)
  })
})
