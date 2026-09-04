import { describe, expect, it } from "vitest"

import { type Job } from "../src/jobTypes.js"
import { JobEngine, NonRetryableError } from "../src/jobEngine.js"
import { createJobWorker, type JobTask } from "../src/jobWorker.js"
import { createInMemoryJobStore } from "../src/jobStore.js"

const TX = "0xfeed"

function makeEngine(options: ConstructorParameters<typeof JobEngine>[1] = {}) {
  let clock = 5_000_000
  const { retry, ...rest } = options
  const engine = new JobEngine(createInMemoryJobStore(), {
    now: () => clock,
    retry: { maxAttempts: 4, baseDelayMs: 0, ...retry },
    ...rest,
  })
  return {
    engine,
    tick(ms: number) {
      clock += ms
    },
  }
}

const succeed: JobTask = async (job) => ({
  resultRef: `audit://${job.id}`,
  verdictId: `verdict-${job.id}`,
  result: { ok: true },
})

describe("job workers", function () {
  it("claims, runs and completes a job in one cycle", async function () {
    const { engine } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    const worker = createJobWorker(engine, { RULES: succeed }, "w1")

    expect(await worker.runOnce()).toBe(1)
    expect(engine.getJob(job.id)?.status).toBe("COMPLETED")
    expect(engine.getJob(job.id)?.resultRef).toBe(`audit://${job.id}`)
    expect(engine.getJob(job.id)?.workerId).toBeNull()
    // Nothing left to do on the next cycle.
    expect(await worker.runOnce()).toBe(0)
  })

  it("retries a flaky analysis and completes on a later attempt", async function () {
    const { engine } = makeEngine()
    let calls = 0
    const flaky: JobTask = async () => {
      calls += 1
      if (calls < 3) throw new Error("upstream rate limited")
      return { resultRef: "audit-final" }
    }
    const worker = createJobWorker(engine, { SIMULATION: flaky }, "w1")

    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    await worker.runOnce()
    expect(engine.getJob(job.id)?.status).toBe("RETRYING")
    expect(engine.getJob(job.id)?.lastError).toMatch(/rate limited/)

    await worker.runOnce() // attempt 2 - fails again
    await worker.runOnce() // attempt 3 - succeeds
    expect(engine.getJob(job.id)?.status).toBe("COMPLETED")
    expect(engine.getJob(job.id)?.attemptCount).toBe(3)
    expect(engine.getJob(job.id)?.retryHistory).toHaveLength(2)
    expect(calls).toBe(3)
  })

  it("dead-letters a permanently failing job after the retry budget, then replays it", async function () {
    const { engine } = makeEngine({ retry: { maxAttempts: 2 } })
    let calls = 0
    // The environment is down for the first two calls, then recovers - so
    // the exact same task both dead-letters and, after replay, completes.
    const flaky: JobTask = async () => {
      calls += 1
      if (calls <= 2) throw new Error("anvil unreachable")
      return { resultRef: "audit-recovered" }
    }
    const worker = createJobWorker(engine, { LLM: flaky }, "w1")

    const job = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    await worker.runOnce() // attempt 1 -> retrying
    await worker.runOnce() // attempt 2 -> dead letter
    expect(engine.getJob(job.id)?.status).toBe("DEAD_LETTER")
    expect(engine.getJob(job.id)?.retryHistory.map((entry) => entry.error)).toEqual([
      "anvil unreachable",
      "anvil unreachable",
    ])
    expect(calls).toBe(2)

    // Replay recovers it; the (now healthy) environment lets it finish.
    engine.replay(job.id)
    await worker.runOnce()
    expect(engine.getJob(job.id)?.status).toBe("COMPLETED")
    expect(engine.getJob(job.id)?.resultRef).toBe("audit-recovered")
  })

  it("fails NonRetryableError tasks immediately without retries", async function () {
    const { engine } = makeEngine({ retry: { maxAttempts: 4 } })
    const badInput: JobTask = async () => {
      throw new NonRetryableError("transaction data is not decodable")
    }
    const worker = createJobWorker(engine, { WALLET_RISK: badInput }, "w1")

    const job = engine.enqueue({ txHash: TX, analysisType: "WALLET_RISK" })
    await worker.runOnce()
    expect(engine.getJob(job.id)?.status).toBe("FAILED")
    expect(engine.getJob(job.id)?.attemptCount).toBe(1)
    await worker.runOnce()
    expect(engine.getJob(job.id)?.status).toBe("FAILED") // never retried
  })

  it("fails a job whose analysis type has no registered task", async function () {
    const { engine } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    const worker = createJobWorker(engine, { RULES: succeed }, "w1")

    await worker.runOnce()
    expect(engine.getJob(job.id)?.status).toBe("FAILED")
    expect(engine.getJob(job.id)?.lastError).toMatch(/no worker task registered for LLM/)
  })

  it("aborts a hung task when its per-job timeout elapses and retries it", async function () {
    const { engine } = makeEngine({ retry: { maxAttempts: 3 } })
    // A task that ignores its AbortSignal and never settles: only the
    // worker's own timeout can stop it.
    const hang: JobTask = () => new Promise(() => {})
    const worker = createJobWorker(engine, { SIMULATION: hang }, "w1")

    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION", timeoutMs: 30 })
    await worker.runOnce()
    const after = engine.getJob(job.id)
    expect(after?.status).toBe("RETRYING")
    expect(after?.lastError).toMatch(/30ms timeout/)
    expect(after?.retryHistory).toHaveLength(1)
  })

  it("honors a job's own timeout over the worker default", async function () {
    const { engine } = makeEngine({ retry: { maxAttempts: 3 } })
    const slow: JobTask = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { resultRef: "late" }
    }
    const worker = createJobWorker(engine, { RULES: slow }, "w1", { timeoutMs: 5_000 })

    const job = engine.enqueue({ txHash: TX, analysisType: "RULES", timeoutMs: 10 })
    await worker.runOnce()
    expect(engine.getJob(job.id)?.lastError).toMatch(/10ms timeout/) // job's own budget won
  })

  it("is duplicate-safe: one event, one job, one result", async function () {
    const { engine } = makeEngine()
    let runs = 0
    const counting: JobTask = async (job) => {
      runs += 1
      return { resultRef: `audit://${job.id}` }
    }
    const workerA = createJobWorker(engine, { RULES: counting }, "w-a")
    const workerB = createJobWorker(engine, { RULES: counting }, "w-b")

    // Same event delivered twice -> enqueue is idempotent (one job).
    engine.enqueue({ txHash: TX, analysisType: "RULES" })
    const dup = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    const job = engine.getJob(dup.id)
    expect(job).toBeDefined()

    // Two workers race; the loser of the claim has nothing to do.
    await workerA.runOnce()
    await workerB.runOnce()
    expect(runs).toBe(1)
    expect(engine.getJob(job!.id)?.status).toBe("COMPLETED")
    expect(engine.listJobs({ txHash: TX, analysisType: "RULES" })).toHaveLength(1)
  })

  it("recovers abandoned jobs during its sweep before claiming", async function () {
    const { engine, tick } = makeEngine({ leaseMs: 1_000, retry: { maxAttempts: 3 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-that-died")

    tick(1_001) // lease expired; no live worker ever finished the job
    const survivor = createJobWorker(engine, { RULES: succeed }, "w-survivor")
    await survivor.runOnce()

    const recovered = engine.getJob(job.id)
    expect(recovered?.retryHistory).toHaveLength(1)
    expect(recovered?.retryHistory[0].error).toMatch(/crashed before finishing/)
    expect(recovered?.status).toBe("COMPLETED")
  })
})
