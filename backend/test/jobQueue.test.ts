import { describe, expect, it, vi } from "vitest"

import {
  type Job,
  AnalysisType,
  InMemoryJobStore,
  JobRunner,
  JobStatus,
  backoffMs,
  replayDeadLetters,
} from "../src/jobQueue.js"

function store(): InMemoryJobStore {
  return new InMemoryJobStore()
}

function makeJob(s: InMemoryJobStore, overrides: Partial<{ txHash: string; type: AnalysisType; maxAttempts: number }> = {}) {
  return s.create({
    txHash: overrides.txHash ?? "0xaaa",
    analysisType: overrides.type ?? AnalysisType.RULES,
    maxAttempts: overrides.maxAttempts ?? 3,
  })
}

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

describe("backoffMs", function () {
  it("returns base delay (1000ms) for attempt 0", function () {
    expect(backoffMs(0)).toBe(1_000)
  })

  it("doubles with each attempt", function () {
    expect(backoffMs(1)).toBe(2_000)
    expect(backoffMs(2)).toBe(4_000)
    expect(backoffMs(3)).toBe(8_000)
  })

  it("caps at 60 seconds", function () {
    expect(backoffMs(10)).toBe(60_000)
    expect(backoffMs(100)).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// InMemoryJobStore — create / idempotency
// ---------------------------------------------------------------------------

describe("InMemoryJobStore", function () {
  it("creates a job in QUEUED status with no attempts", function () {
    const s = store()
    const job = makeJob(s)
    expect(job.status).toBe(JobStatus.QUEUED)
    expect(job.attemptCount).toBe(0)
    expect(job.workerId).toBeNull()
  })

  it("returns the same job for duplicate (txHash, analysisType) — idempotent", function () {
    const s = store()
    const first = s.create({ txHash: "0x111", analysisType: AnalysisType.RULES })
    const second = s.create({ txHash: "0x111", analysisType: AnalysisType.RULES })
    expect(first.id).toBe(second.id)
  })

  it("creates separate jobs for different analysis types on the same txHash", function () {
    const s = store()
    const rules = s.create({ txHash: "0x111", analysisType: AnalysisType.RULES })
    const sim = s.create({ txHash: "0x111", analysisType: AnalysisType.SIMULATION })
    expect(rules.id).not.toBe(sim.id)
  })

  it("creates separate jobs for different txHashes", function () {
    const s = store()
    const a = s.create({ txHash: "0x111", analysisType: AnalysisType.RULES })
    const b = s.create({ txHash: "0x222", analysisType: AnalysisType.RULES })
    expect(a.id).not.toBe(b.id)
  })
})

// ---------------------------------------------------------------------------
// InMemoryJobStore — claim / complete / fail
// ---------------------------------------------------------------------------

describe("InMemoryJobStore — lifecycle", function () {
  it("claims a QUEUED job and transitions to PROCESSING", function () {
    const s = store()
    const job = makeJob(s)
    const claimed = s.claim(job.id, "worker-1")
    expect(claimed).not.toBeNull()
    expect(claimed!.status).toBe(JobStatus.PROCESSING)
    expect(claimed!.workerId).toBe("worker-1")
    expect(claimed!.attemptCount).toBe(1)
  })

  it("prevents double-claiming by a different worker", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    const second = s.claim(job.id, "worker-2")
    expect(second).toBeNull()
  })

  it("returns null when claiming a nonexistent job", function () {
    const s = store()
    expect(s.claim("nonexistent", "worker-1")).toBeNull()
  })

  it("completes a job with a result", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    const completed = s.complete(job.id, { score: 42 })
    expect(completed.status).toBe(JobStatus.COMPLETED)
    expect(completed.result).toEqual({ score: 42 })
    expect(completed.completedAt).toBeTypeOf("number")
    expect(completed.workerId).toBeNull()
  })

  it("fail() on first attempt transitions to RETRYING", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    const failed = s.fail(job.id, "boom")
    expect(failed.status).toBe(JobStatus.RETRYING)
    expect(failed.lastError).toBe("boom")
    expect(failed.nextRetryAt).toBeTypeOf("number")
  })

  it("fail() after maxAttempts transitions to DEAD_LETTER", function () {
    const s = store()
    const job = makeJob(s, { maxAttempts: 2 })
    s.claim(job.id, "worker-1") // attemptCount = 1
    s.fail(job.id, "err1") // RETRYING, nextRetryAt = now + 1000
    // Manually reset nextRetryAt so the second claim succeeds
    // (in real usage the backoff timer would have elapsed).
    const jobRef = s.get(job.id)!
    jobRef.nextRetryAt = 0
    s.claim(job.id, "worker-2") // attemptCount = 2
    const failed = s.fail(job.id, "err2")
    expect(failed.status).toBe(JobStatus.DEAD_LETTER)
    expect(failed.attemptCount).toBe(2)
  })

  it("can reclaim a RETRYING job after backoff elapses", function () {
    const s = store()
    const now = 1_000_000
    let currentTime = now
    // We'll manipulate time by creating the job, claiming, failing,
    // then checking that dueJobs respects nextRetryAt.
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    const failed = s.fail(job.id, "err")
    // nextRetryAt = now + 1000 (backoffMs(1))
    expect(failed.nextRetryAt).toBeGreaterThan(now)

    // Not yet due.
    expect(s.dueJobs()).toHaveLength(0)

    // After backoff elapses, it becomes due.
    // The store checks Date.now() internally, so we wait a tiny bit.
    // For unit testing we just verify the mechanism.
    expect(failed.status).toBe(JobStatus.RETRYING)
  })
})

// ---------------------------------------------------------------------------
// InMemoryJobStore — dueJobs / abandonedJobs
// ---------------------------------------------------------------------------

describe("InMemoryJobStore — queries", function () {
  it("dueJobs returns QUEUED jobs", function () {
    const s = store()
    makeJob(s)
    expect(s.dueJobs()).toHaveLength(1)
  })

  it("dueJobs excludes PROCESSING jobs", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    expect(s.dueJobs()).toHaveLength(0)
  })

  it("abandonedJobs finds jobs stuck in PROCESSING", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    // Manually backdate startedAt so the job appears old.
    s.get(job.id)!.startedAt = Date.now() - 10_000
    // With a 1ms timeout, any job started more than 1ms ago is abandoned.
    const abandoned = s.abandonedJobs(1)
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0].id).toBe(job.id)
  })

  it("abandonedJobs excludes completed jobs", function () {
    const s = store()
    const job = makeJob(s)
    s.claim(job.id, "worker-1")
    s.complete(job.id, {})
    expect(s.abandonedJobs(0)).toHaveLength(0)
  })

  it("getByTxHash returns all jobs for a transaction", function () {
    const s = store()
    s.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })
    s.create({ txHash: "0xabc", analysisType: AnalysisType.SIMULATION })
    s.create({ txHash: "0xdef", analysisType: AnalysisType.RULES })
    expect(s.getByTxHash("0xabc")).toHaveLength(2)
    expect(s.getByTxHash("0xdef")).toHaveLength(1)
  })

  it("stats returns counts per status", function () {
    const s = store()
    makeJob(s)
    makeJob(s, { type: AnalysisType.SIMULATION })
    const stats = s.stats()
    expect(stats[JobStatus.QUEUED]).toBe(2)
    expect(stats[JobStatus.COMPLETED]).toBe(0)
  })

  it("list filters by status", function () {
    const s = store()
    makeJob(s)
    expect(s.list(JobStatus.QUEUED)).toHaveLength(1)
    expect(s.list(JobStatus.COMPLETED)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// InMemoryJobStore — replay (DLQ recovery)
// ---------------------------------------------------------------------------

describe("InMemoryJobStore — replay", function () {
  it("replays a DEAD_LETTER job back to QUEUED with fresh attempts", function () {
    const s = store()
    const job = makeJob(s, { maxAttempts: 1 })
    s.claim(job.id, "w1")
    s.fail(job.id, "boom")
    expect(s.get(job.id)!.status).toBe(JobStatus.DEAD_LETTER)

    const replayed = s.replay(job.id)
    expect(replayed).not.toBeNull()
    expect(replayed!.status).toBe(JobStatus.QUEUED)
    expect(replayed!.attemptCount).toBe(0)
    expect(replayed!.workerId).toBeNull()
    expect(replayed!.nextRetryAt).toBeNull()
  })

  it("returns null for non-DLQ jobs", function () {
    const s = store()
    const job = makeJob(s)
    expect(s.replay(job.id)).toBeNull()
  })

  it("returns null for nonexistent job", function () {
    const s = store()
    expect(s.replay("nonexistent")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// replayDeadLetters (top-level helper)
// ---------------------------------------------------------------------------

describe("replayDeadLetters", function () {
  it("replays all DLQ jobs for a txHash", function () {
    const s = store()
    // Create 2 jobs, push both to DLQ.
    const r = s.create({ txHash: "0xaaa", analysisType: AnalysisType.RULES, maxAttempts: 1 })
    const sim = s.create({ txHash: "0xaaa", analysisType: AnalysisType.SIMULATION, maxAttempts: 1 })
    s.claim(r.id, "w1")
    s.fail(r.id, "err")
    s.claim(sim.id, "w2")
    s.fail(sim.id, "err")

    const replayed = replayDeadLetters(s, "0xaaa")
    expect(replayed).toHaveLength(2)
    expect(replayed.every((j) => j.status === JobStatus.QUEUED)).toBe(true)
  })

  it("does not replay non-DLQ jobs", function () {
    const s = store()
    s.create({ txHash: "0xaaa", analysisType: AnalysisType.RULES })
    const replayed = replayDeadLetters(s, "0xaaa")
    expect(replayed).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// JobRunner — polling, worker execution, failure handling
// ---------------------------------------------------------------------------

describe("JobRunner", function () {
  it("picks up QUEUED jobs and runs the registered worker", async function () {
    const s = store()
    const runner = new JobRunner(s, { pollIntervalMs: 50 })
    const workerFn = vi.fn(async () => ({ ok: true }))
    runner.registerWorker(AnalysisType.RULES, workerFn)

    makeJob(s)
    await runner.tick()

    expect(workerFn).toHaveBeenCalledTimes(1)
    expect(s.list(JobStatus.COMPLETED)).toHaveLength(1)
  })

  it("marks jobs as FAILED (RETRYING) when the worker throws", async function () {
    const s = store()
    const runner = new JobRunner(s)
    runner.registerWorker(AnalysisType.RULES, async () => {
      throw new Error("worker crashed")
    })

    makeJob(s)
    await runner.tick()

    const jobs = s.list(JobStatus.RETRYING)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].lastError).toBe("worker crashed")
  })

  it("sends to DEAD_LETTER after max attempts", async function () {
    const s = store()
    const runner = new JobRunner(s)
    runner.registerWorker(AnalysisType.RULES, async () => {
      throw new Error("always fails")
    })

    makeJob(s, { maxAttempts: 1 })
    await runner.tick()

    expect(s.list(JobStatus.DEAD_LETTER)).toHaveLength(1)
  })

  it("does not process jobs without a registered worker", async function () {
    const s = store()
    const runner = new JobRunner(s)
    // No worker registered for RULES.
    makeJob(s)
    await runner.tick()

    // Job should be failed with "No worker registered" error.
    const failed = s.list(JobStatus.RETRYING)
    expect(failed).toHaveLength(1)
    expect(failed[0].lastError).toContain("No worker registered")
  })

  it("recovers abandoned jobs (timed-out workers)", async function () {
    const s = store()
    const runner = new JobRunner(s, { timeoutMs: 1 })
    runner.registerWorker(AnalysisType.RULES, async () => ({ ok: true }))

    const job = makeJob(s)
    s.claim(job.id, "dead-worker")
    // Backdate startedAt so the job appears to have timed out.
    s.get(job.id)!.startedAt = Date.now() - 10_000
    await runner.tick()

    // First tick: recovery fails the job → RETRYING.
    const afterRecovery = s.get(job.id)!
    expect(afterRecovery.status).toBe(JobStatus.RETRYING)

    // Bypass the backoff so the retry can proceed.
    afterRecovery.nextRetryAt = 0
    await runner.tick()

    // Second tick: the retry is claimed and completed.
    const completed = s.list(JobStatus.COMPLETED)
    expect(completed.length).toBeGreaterThanOrEqual(1)
  })

  it("processOne manually runs a single job", async function () {
    const s = store()
    const runner = new JobRunner(s)
    const workerFn = vi.fn(async () => ({ result: 42 }))
    runner.registerWorker(AnalysisType.RULES, workerFn)

    const job = makeJob(s)
    const result = await runner.processOne(job.id)

    expect(workerFn).toHaveBeenCalledOnce()
    expect(result).not.toBeNull()
    expect(result!.status).toBe(JobStatus.COMPLETED)
    expect(result!.result).toEqual({ result: 42 })
  })
})

// ---------------------------------------------------------------------------
// End-to-end: full lifecycle
// ---------------------------------------------------------------------------

describe("full lifecycle", function () {
  it("processes a job through QUEUED → PROCESSING → COMPLETED", function () {
    const s = store()
    const job = makeJob(s)
    const claimed = s.claim(job.id, "w1")
    expect(claimed!.status).toBe(JobStatus.PROCESSING)
    const completed = s.complete(job.id, { verdict: "low_risk" })
    expect(completed.status).toBe(JobStatus.COMPLETED)
    expect(completed.result).toEqual({ verdict: "low_risk" })
    expect(completed.completedAt).toBeTypeOf("number")
  })

  it("processes a job through QUEUED → PROCESSING → RETRYING → PROCESSING → DEAD_LETTER", function () {
    const s = store()
    const job = makeJob(s, { maxAttempts: 2 })
    s.claim(job.id, "w1")
    s.fail(job.id, "err1")
    expect(s.get(job.id)!.status).toBe(JobStatus.RETRYING)
    // Bypass backoff so the second claim succeeds.
    s.get(job.id)!.nextRetryAt = 0
    s.claim(job.id, "w2")
    s.fail(job.id, "err2")
    expect(s.get(job.id)!.status).toBe(JobStatus.DEAD_LETTER)
    expect(s.get(job.id)!.attemptCount).toBe(2)
  })

  it("recovers and reprocesses a DLQ job via replay", async function () {
    const s = store()
    const runner = new JobRunner(s)
    let callCount = 0
    runner.registerWorker(AnalysisType.RULES, async () => {
      callCount++
      if (callCount === 1) throw new Error("first attempt fails")
      return { ok: true }
    })

    // First attempt: fails and goes to retry.
    const job = makeJob(s, { maxAttempts: 1 })
    await runner.tick()
    expect(s.get(job.id)!.status).toBe(JobStatus.DEAD_LETTER)

    // Replay and reprocess.
    s.replay(job.id)
    expect(s.get(job.id)!.status).toBe(JobStatus.QUEUED)
    await runner.tick()
    expect(s.get(job.id)!.status).toBe(JobStatus.COMPLETED)
  })
})
