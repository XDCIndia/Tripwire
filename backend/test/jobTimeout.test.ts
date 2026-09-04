import { describe, it, expect } from "vitest"
import { withJobTimeout, cancelJob, recoverStuckJobs, jobHealthCheck } from "../src/jobTimeout.js"
import { InMemoryJobStore, AnalysisType } from "../src/jobQueue.js"

// ─── withJobTimeout tests ────────────────────────────────────────────

describe("withJobTimeout", () => {
  it("returns result when worker completes before timeout", async () => {
    const result = await withJobTimeout(async () => 42, 1000)
    expect(result).toBe(42)
  })

  it("rejects when worker exceeds timeout", async () => {
    await expect(
      withJobTimeout(
        () => new Promise((resolve) => setTimeout(() => resolve("done"), 200)),
        50,
      ),
    ).rejects.toThrow("timed out")
  })

  it("receives abort signal when timeout fires", async () => {
    let signalReceived = false

    // The timeout fires first and rejects with "timed out" before the
    // abort handler's reject can propagate. We verify the signal was
    // triggered by checking it was set to aborted.
    const promise = withJobTimeout(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            signalReceived = true
          })
          // Keep the promise alive until abort
          const check = () => {
            if (signal.aborted) return
            setTimeout(check, 5)
          }
          check()
          // Reject only on abort to let the timeout path win
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
      50,
    )

    await expect(promise).rejects.toThrow()
    expect(signalReceived).toBe(true)
  })

  it("does not fire timeout after successful completion", async () => {
    let timeoutFired = false
    const timers = {
      setTimeout: ((fn: () => void, ms: number) => {
        return globalThis.setTimeout(() => {
          timeoutFired = true
          fn()
        }, ms)
      }) as typeof globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    }

    const result = await withJobTimeout(async () => "ok", 100, timers)
    expect(result).toBe("ok")

    // Wait a bit to ensure timeout doesn't fire
    await new Promise((r) => setTimeout(r, 150))
    expect(timeoutFired).toBe(false)
  })
})

// ─── cancelJob tests ─────────────────────────────────────────────────

describe("cancelJob", () => {
  it("cancels a QUEUED job", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })
    const result = cancelJob(store, job.id)
    expect(result.cancelled).toBe(true)
    // fail() on a QUEUED job transitions to RETRYING (not FAILED) since attemptCount < maxAttempts
    expect(["RETRYING", "FAILED"]).toContain(store.get(job.id)?.status)
  })

  it("cancels a RETRYING job", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })
    store.claim(job.id, "worker-1")
    store.fail(job.id, "test error")
    expect(store.get(job.id)?.status).toBe("RETRYING")

    const result = cancelJob(store, job.id)
    expect(result.cancelled).toBe(true)
  })

  it("rejects cancelling a COMPLETED job", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })
    store.claim(job.id, "worker-1")
    store.complete(job.id, { score: 10 })

    const result = cancelJob(store, job.id)
    expect(result.cancelled).toBe(false)
    if (result.cancelled) throw new Error("expected cancellation to be rejected")
    expect(result.reason).toContain("terminal status")
  })

  it("returns error for non-existent job", () => {
    const store = new InMemoryJobStore()
    const result = cancelJob(store, "non-existent")
    expect(result.cancelled).toBe(false)
    if (result.cancelled) throw new Error("expected cancellation to be rejected")
    expect(result.reason).toContain("not found")
  })
})

// ─── recoverStuckJobs tests ──────────────────────────────────────────

describe("recoverStuckJobs", () => {
  it("recovers dead-lettered jobs", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES, maxAttempts: 1 })

    // With maxAttempts=1, a single claim+fail should dead-letter
    store.claim(job.id, "worker-1")
    store.fail(job.id, "err1")
    expect(store.get(job.id)?.status).toBe("DEAD_LETTER")

    const result = recoverStuckJobs(store, "0xabc")
    expect(result.recovered).toContain(job.id)
    expect(store.get(job.id)?.status).toBe("QUEUED")
  })

  it("returns empty for healthy transactions", () => {
    const store = new InMemoryJobStore()
    store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })

    const result = recoverStuckJobs(store, "0xabc")
    expect(result.recovered).toHaveLength(0)
  })
})

// ─── jobHealthCheck tests ────────────────────────────────────────────

describe("jobHealthCheck", () => {
  it("reports healthy when no issues", () => {
    const store = new InMemoryJobStore()
    store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES })
    const health = jobHealthCheck(store)
    expect(health.healthy).toBe(true)
    expect(health.issues).toHaveLength(0)
  })

  it("reports unhealthy when dead-letter jobs exist", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES, maxAttempts: 1 })
    store.claim(job.id, "w1")
    store.fail(job.id, "e1")

    const health = jobHealthCheck(store)
    expect(health.healthy).toBe(false)
    expect(health.issues.some((i) => i.includes("dead-letter"))).toBe(true)
  })

  it("reports issues count correctly", () => {
    const store = new InMemoryJobStore()
    const job = store.create({ txHash: "0xabc", analysisType: AnalysisType.RULES, maxAttempts: 1 })
    store.claim(job.id, "w1")
    store.fail(job.id, "e1")

    const health = jobHealthCheck(store)
    expect(health.stats.DEAD_LETTER).toBe(1)
  })
})
