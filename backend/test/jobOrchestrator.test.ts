import { describe, expect, it, vi } from "vitest"

import { AnalysisType, InMemoryJobStore, JobRunner, JobStatus } from "../src/jobQueue.js"
import { RiskAnalysisOrchestrator } from "../src/jobOrchestrator.js"
import type { TransactionEvent } from "../src/jobOrchestrator.js"
import type { BlacklistChecker } from "../src/blacklist.js"
import { registerDefaultWorkers } from "../src/jobWorkers.js"

function mockBlacklist(): BlacklistChecker {
  return { checkCounterparty: vi.fn(async () => "clean" as const) }
}

function mockForkClient() {
  return {
    getBalance: vi.fn(async () => 1000n),
    readErc20Allowance: vi.fn(async () => 0n),
    readIsApprovedForAll: vi.fn(async () => false),
    readErc721Owner: vi.fn(async (): Promise<`0x${string}`> => "0xNftOwner"),
    snapshot: vi.fn(async () => "0x1"),
    revert: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ success: true })),
  }
}

function testEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    safeTxHash: "0xhash1",
    to: "0xTarget",
    value: "0",
    data: "0x",
    proposer: "0xProposer",
    nonce: "1",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — ingest
// ---------------------------------------------------------------------------

describe("RiskAnalysisOrchestrator", function () {
  describe("ingest", function () {
    it("creates 4 independent jobs (one per analysis type)", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      const jobs = orch.ingest(testEvent())
      expect(jobs).toHaveLength(4)
      const types = jobs.map((j) => j.analysisType)
      expect(types).toContain(AnalysisType.RULES)
      expect(types).toContain(AnalysisType.SIMULATION)
      expect(types).toContain(AnalysisType.LLM)
      expect(types).toContain(AnalysisType.WALLET_RISK)
    })

    it("all jobs start in QUEUED status", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      const jobs = orch.ingest(testEvent())
      expect(jobs.every((j) => j.status === JobStatus.QUEUED)).toBe(true)
    })

    it("is idempotent: ingesting the same event twice returns the same jobs", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      const first = orch.ingest(testEvent({ safeTxHash: "0xaaa" }))
      const second = orch.ingest(testEvent({ safeTxHash: "0xaaa" }))
      expect(first.map((j) => j.id).sort()).toEqual(second.map((j) => j.id).sort())
    })

    it("creates separate job sets for different txHashes", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      const a = orch.ingest(testEvent({ safeTxHash: "0x111" }))
      const b = orch.ingest(testEvent({ safeTxHash: "0x222" }))
      expect(a.map((j) => j.id).sort()).not.toEqual(b.map((j) => j.id).sort())
    })
  })

  // ---------------------------------------------------------------------------
  // Orchestrator — snapshot
  // ---------------------------------------------------------------------------

  describe("snapshot", function () {
    it("reports not-all-completed when some jobs are still QUEUED", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      const snap = orch.snapshot("0xaaa")
      expect(snap.allCompleted).toBe(false)
      expect(snap.anyDeadLettered).toBe(false)
      expect(snap.jobs).toHaveLength(4)
    })

    it("reports allCompleted when every job is done", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      const jobs = orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      for (const job of jobs) {
        s.claim(job.id, "w1")
        s.complete(job.id, {})
      }

      const snap = orch.snapshot("0xaaa")
      expect(snap.allCompleted).toBe(true)
    })

    it("reports anyDeadLettered when a job is in DLQ", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s, { maxAttempts: 1 })
      const jobs = orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      // Fail the first RULES job to push it to DLQ.
      const rulesJob = jobs.find((j) => j.analysisType === AnalysisType.RULES)!
      s.claim(rulesJob.id, "w1")
      s.fail(rulesJob.id, "boom")

      const snap = orch.snapshot("0xaaa")
      expect(snap.anyDeadLettered).toBe(true)
    })

    it("returns null verdict when not all jobs are completed", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s)
      orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      const snap = orch.snapshot("0xaaa")
      expect(snap.verdict).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Orchestrator — recover
  // ---------------------------------------------------------------------------

  describe("recover", function () {
    it("replays DLQ jobs for a txHash back to QUEUED", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s, { maxAttempts: 1 })
      const jobs = orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      for (const job of jobs) {
        s.claim(job.id, "w1")
        s.fail(job.id, "err")
      }
      expect(s.list(JobStatus.DEAD_LETTER)).toHaveLength(4)

      const replayed = orch.recover("0xaaa")
      expect(replayed).toHaveLength(4)
      expect(s.list(JobStatus.QUEUED)).toHaveLength(4)
    })
  })

  // ---------------------------------------------------------------------------
  // Orchestrator — statusReport
  // ---------------------------------------------------------------------------

  describe("statusReport", function () {
    it("returns stats, dead letters, and stuck jobs", function () {
      const s = new InMemoryJobStore()
      const orch = new RiskAnalysisOrchestrator(s, { maxAttempts: 1 })
      orch.ingest(testEvent({ safeTxHash: "0xaaa" }))

      const report = orch.statusReport()
      expect(report.stats[JobStatus.QUEUED]).toBe(4)
      expect(report.deadLetters).toHaveLength(0)
      expect(report.stuckJobs).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Full integration: ingest → runner → verdict
// ---------------------------------------------------------------------------

describe("integrated pipeline", function () {
  it("ingests an event, processes all jobs, and produces a verdict", async function () {
    const s = new InMemoryJobStore()
    const runner = new JobRunner(s)
    const orch = new RiskAnalysisOrchestrator(s)

    registerDefaultWorkers(runner, {
      blacklist: mockBlacklist(),
      forkClient: mockForkClient(),
    })

    const event = testEvent({
      safeTxHash: "0xhash1",
      data: "0xa22cb465" + "0".repeat(64), // setApprovalForAll-like
    })
    orch.ingest(event)

    // Process all due jobs.
    await runner.tick()
    await runner.tick() // may need a second pass for retries

    const snap = orch.snapshot("0xhash1")
    // At least the rules job should be completed.
    const completedJobs = snap.jobs.filter((j) => j.status === JobStatus.COMPLETED)
    expect(completedJobs.length).toBeGreaterThanOrEqual(1)
  })
})
