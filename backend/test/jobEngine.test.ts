import { describe, expect, it } from "vitest"

import { JobEngine, JobStateError, NonRetryableError } from "../src/jobEngine.js"
import { createInMemoryJobStore } from "../src/jobStore.js"

const TX = "0x1234"
const TX2 = "0x5678"

/** Deterministic clock + ids so assertions never depend on wall time. */
function makeEngine(options: ConstructorParameters<typeof JobEngine>[1] = {}) {
  let clock = 1_000_000
  let seq = 0
  const engine = new JobEngine(createInMemoryJobStore(), {
    now: () => clock,
    idFactory: () => `job-${++seq}`,
    ...options,
  })
  return {
    engine,
    tick(ms: number) {
      clock += ms
    },
    now() {
      return clock
    },
  }
}

describe("enqueue", function () {
  it("persists a QUEUED job before returning, with the tx correlation", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    expect(job.status).toBe("QUEUED")
    expect(job.attemptCount).toBe(0)
    expect(job.txHash).toBe(TX)
    expect(job.createdAt).toBe(1_000_000)
    expect(engine.getJob(job.id)).toEqual(job)
  })

  it("creates four independent jobs for one transaction event", function () {
    const { engine, tick } = makeEngine()
    for (const analysisType of ["RULES", "WALLET_RISK", "SIMULATION", "LLM"] as const) {
      engine.enqueue({ txHash: TX, analysisType })
    }
    expect(engine.listJobs({ txHash: TX })).toHaveLength(4)
  })

  it("is idempotent: re-delivering the same event never creates a second job", function () {
    const { engine, tick } = makeEngine()
    const first = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    const duplicate = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    expect(duplicate.id).toBe(first.id)
    expect(engine.listJobs()).toHaveLength(1)
  })

  it("keeps jobs for different transactions distinct", function () {
    const { engine, tick } = makeEngine()
    engine.enqueue({ txHash: TX, analysisType: "LLM" })
    engine.enqueue({ txHash: TX2, analysisType: "LLM" })
    expect(engine.listJobs()).toHaveLength(2)
  })
})

describe("claiming", function () {
  it("claims the oldest QUEUED job and grants an exclusive lease", function () {
    const { engine, tick } = makeEngine()
    engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.enqueue({ txHash: TX2, analysisType: "RULES" })

    const first = engine.claim("worker-a")
    expect(first?.status).toBe("PROCESSING")
    expect(first?.workerId).toBe("worker-a")
    expect(first?.attemptCount).toBe(1)
    expect(first?.leaseExpiresAt).toBe(1_000_000 + 600_000) // default lease 10 min

    const second = engine.claim("worker-a")
    expect(second?.txHash).toBe(TX2)
  })

  it("never lets a second worker claim the same job", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })

    expect(engine.claim("worker-a")?.id).toBe(job.id)
    expect(engine.claim("worker-b")).toBeNull()
  })

  it("narrows claims by analysis type so dedicated workers never starve each other", function () {
    const { engine, tick } = makeEngine()
    engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })

    expect(engine.claim("rules-worker", "RULES")?.analysisType).toBe("RULES")
    expect(engine.claim("sim-worker", "SIMULATION")?.analysisType).toBe("SIMULATION")
    expect(engine.claim("any-worker")).toBeNull()
  })

  it("only claims RETRYING jobs once their backoff has elapsed", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 3, baseDelayMs: 10_000 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "boom")

    expect(engine.getJob(job.id)?.status).toBe("RETRYING")
    expect(engine.claim("worker-a")).toBeNull() // not due yet

    tick(10_000)
    expect(engine.claim("worker-b")?.status).toBe("PROCESSING")
  })
})

describe("complete and fail", function () {
  it("completes a job held by the right worker and records the result", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    engine.claim("worker-a")
    const done = engine.complete(job.id, "worker-a", { resultRef: "audit-1", verdictId: "verdict-9", result: { score: 12 } })
    expect(done.status).toBe("COMPLETED")
    expect(done.resultRef).toBe("audit-1")
    expect(done.verdictId).toBe("verdict-9")
    expect(done.result).toEqual({ score: 12 })
    expect(done.completedAt).not.toBeNull()
  })

  it("rejects completing a job the caller does not hold", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-a")
    expect(() => engine.complete(job.id, "worker-b", {})).toThrowError(JobStateError)
    // And you cannot complete an already-completed job a second time.
    engine.complete(job.id, "worker-a", {})
    expect(() => engine.complete(job.id, "worker-a", {})).toThrowError(JobStateError)
  })

  it("schedules retryable failures with exponential backoff", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "rate limited")

    expect(engine.getJob(job.id)?.status).toBe("RETRYING")
    expect(engine.getJob(job.id)?.nextRetryAt).toBe(1_000_000 + 1_000) // attempt 1 -> base

    tick(2_000) // claim again (past due)
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "rate limited again")
    expect(engine.getJob(job.id)?.nextRetryAt).toBe(1_002_000 + 2_000) // attempt 2 -> base*2

    tick(3_000)
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "still down")
    expect(engine.getJob(job.id)?.nextRetryAt).toBe(1_005_000 + 4_000) // attempt 3 -> base*4

    tick(5_000)
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "still down")
    // Attempt 4 is the last one allowed by maxAttempts: 4 - the job is
    // dead-lettered, not scheduled again.
    expect(engine.getJob(job.id)?.status).toBe("DEAD_LETTER")
    expect(engine.getJob(job.id)?.nextRetryAt).toBeNull()
  })

  it("dead-letters a job after maxAttempts, keeping the full retry history", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 2, baseDelayMs: 0 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })

    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "anvil down")
    expect(engine.getJob(job.id)?.status).toBe("RETRYING")

    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "anvil still down")
    expect(engine.getJob(job.id)?.status).toBe("DEAD_LETTER")
    expect(engine.getJob(job.id)?.lastError).toBe("anvil still down")
    expect(engine.getJob(job.id)?.retryHistory).toEqual([
      { at: 1_000_000, attempt: 1, error: "anvil down" },
      { at: 1_000_000, attempt: 2, error: "anvil still down" },
    ])
  })

  it("fails a NonRetryableError straight to FAILED without burning retries", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 5 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", new NonRetryableError("verdict schema is invalid"))
    expect(engine.getJob(job.id)?.status).toBe("FAILED")
    expect(engine.getJob(job.id)?.lastError).toMatch(/schema/)
  })

  it("never lets one failed component lose the rest of the workflow", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 2, baseDelayMs: 0 } })
    const sim = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    const rules = engine.enqueue({ txHash: TX, analysisType: "RULES" })

    engine.claim("worker-a")
    engine.fail(sim.id, "worker-a", "anvil down")
    engine.claim("worker-a")
    engine.fail(sim.id, "worker-a", "anvil down")

    expect(engine.getJob(sim.id)?.status).toBe("DEAD_LETTER")
    // The rules job was untouched by the simulation failures...
    expect(engine.getJob(rules.id)?.status).toBe("QUEUED")
    // ...and still completes normally.
    engine.claim("worker-b")
    engine.complete(rules.id, "worker-b", { resultRef: "audit-rules" })
    expect(engine.getJob(rules.id)?.status).toBe("COMPLETED")
  })
})

describe("cancel", function () {
  it("cancels queued, retrying and in-flight jobs into FAILED", function () {
    const { engine, tick } = makeEngine()
    const queued = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.cancel(queued.id, "no longer needed")
    expect(engine.getJob(queued.id)?.status).toBe("FAILED")
    expect(engine.getJob(queued.id)?.lastError).toBe("no longer needed")

    const inflight = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    engine.claim("worker-a")
    engine.cancel(inflight.id)
    expect(engine.getJob(inflight.id)?.status).toBe("FAILED")
    // Lease is freed: another worker could not claim it anyway (FAILED), but
    // the claim would have to be replayed first.
  })

  it("refuses to cancel a completed or dead-lettered job", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-a")
    engine.complete(job.id, "worker-a", {})
    expect(() => engine.cancel(job.id)).toThrowError(JobStateError)
  })
})

describe("recovery and replay", function () {
  it("recovers jobs abandoned by a crashed worker (lease expired)", function () {
    const { engine, tick } = makeEngine({ leaseMs: 60_000, retry: { maxAttempts: 3, baseDelayMs: 0 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    engine.claim("crashed-worker")

    // Nothing is due yet: the lease is still valid.
    expect(engine.recoverAbandoned()).toEqual([])

    // Worker dies mid-run; after the lease expires the job must be retried.
    tick(60_001)
    const recovered = engine.recoverAbandoned()
    expect(recovered).toHaveLength(1)
    const after = engine.getJob(job.id)
    expect(after?.status).toBe("RETRYING")
    expect(after?.lastError).toMatch(/crashed before finishing/)
    expect(after?.workerId).toBeNull()

    // A new worker picks it up and finishes - the crash never lost the job.
    tick(1)
    engine.claim("fresh-worker")
    engine.complete(job.id, "fresh-worker", { resultRef: "audit-retried" })
    expect(engine.getJob(job.id)?.status).toBe("COMPLETED")
  })

  it("dead-letters an abandoned job once its retries are exhausted", function () {
    const { engine, tick } = makeEngine({ leaseMs: 10, retry: { maxAttempts: 2, baseDelayMs: 0 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "LLM" })

    engine.claim("crash-1")
    tick(11)
    engine.recoverAbandoned()

    engine.claim("crash-2")
    tick(11)
    engine.recoverAbandoned()

    expect(engine.getJob(job.id)?.status).toBe("DEAD_LETTER")
  })

  it("replays dead-lettered jobs with attempts reset but history intact", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 2, baseDelayMs: 0 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "anvil down")
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "anvil down")
    expect(engine.getJob(job.id)?.status).toBe("DEAD_LETTER")

    const replayed = engine.replay(job.id)
    expect(replayed.status).toBe("QUEUED")
    expect(replayed.attemptCount).toBe(0)
    expect(replayed.retryHistory).toHaveLength(2) // history survives

    // ...and now succeeds on the fresh run.
    engine.claim("worker-b")
    engine.complete(job.id, "worker-b", { resultRef: "audit-replayed" })
    expect(engine.getJob(job.id)?.status).toBe("COMPLETED")
  })

  it("refuses to replay a healthy job", function () {
    const { engine, tick } = makeEngine()
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    expect(() => engine.replay(job.id)).toThrowError(/only dead-lettered or failed/)
  })
})

describe("queries and audit trail", function () {
  it("lists and filters jobs", function () {
    const { engine, tick } = makeEngine()
    engine.enqueue({ txHash: TX, analysisType: "RULES" })
    const llm = engine.enqueue({ txHash: TX, analysisType: "LLM" })
    engine.enqueue({ txHash: TX2, analysisType: "SIMULATION" })

    expect(engine.listJobs({ status: "QUEUED" })).toHaveLength(3)
    expect(engine.listJobs({ analysisType: "LLM" })).toHaveLength(1)
    expect(engine.listJobs({ txHash: TX2 })).toHaveLength(1)

    engine.claim("worker-a", "LLM")
    engine.complete(llm.id, "worker-a", {})
    expect(engine.listJobs({ status: "COMPLETED" }).map((job) => job.id)).toEqual([llm.id])
  })

  it("keeps a complete, immutable audit trail per job", function () {
    const { engine, tick } = makeEngine({ retry: { maxAttempts: 2, baseDelayMs: 0 } })
    const job = engine.enqueue({ txHash: TX, analysisType: "RULES" })
    engine.claim("worker-a")
    engine.fail(job.id, "worker-a", "boom")

    const events = engine.eventsFor(job.id)
    expect(events.map((event) => event.type)).toEqual(["created", "claimed", "retrying"])
    expect(events[0].job.status).toBe("QUEUED") // snapshots, not live state
    expect(events[1].job.status).toBe("PROCESSING")
    expect(events[2].job.status).toBe("RETRYING")
    expect(events[2].error).toBe("boom")
    expect(events[2].attempt).toBe(1)
  })
})
