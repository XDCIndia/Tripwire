import { describe, expect, it } from "vitest"

import { type Job } from "../src/jobTypes.js"
import { JobEngine } from "../src/jobEngine.js"
import { handleJobApiRequest, startJobStatusServer } from "../src/jobStatusApi.js"
import { createInMemoryJobStore } from "../src/jobStore.js"

const TX = "0xdeadbeef"

function seedEngine(): JobEngine {
  let clock = 1_000
  const engine = new JobEngine(createInMemoryJobStore(), {
    now: () => clock,
    retry: { maxAttempts: 2, baseDelayMs: 0 },
    idFactory: (() => {
      let seq = 0
      return () => `job-${++seq}`
    })(),
  })
  engine.enqueue({ txHash: TX, analysisType: "RULES" })
  engine.enqueue({ txHash: TX, analysisType: "SIMULATION" })

  // One healthy completed job...
  const rules = engine.listJobs({ analysisType: "RULES" })[0]
  engine.claim("w1", "RULES")
  engine.complete(rules.id, "w1", { resultRef: "audit-1", verdictId: "verdict-1" })

  // ...and one dead-lettered job with a full failure history.
  const sim = engine.listJobs({ analysisType: "SIMULATION" })[0]
  engine.claim("w1", "SIMULATION")
  engine.fail(sim.id, "w1", "anvil down")
  engine.claim("w1", "SIMULATION")
  engine.fail(sim.id, "w1", "anvil down again")
  return engine
}

function deadLettered(engine: JobEngine): Job {
  return engine.listJobs({ status: "DEAD_LETTER" })[0]
}

describe("job status API (pure handler)", function () {
  it("serves /health", function () {
    expect(handleJobApiRequest(seedEngine(), "GET", "/health")).toEqual({ status: 200, json: { ok: true } })
  })

  it("lists all jobs and applies filters", function () {
    const engine = seedEngine()
    const all = handleJobApiRequest(engine, "GET", "/jobs")
    expect(all.status).toBe(200)
    expect((all.json as { count: number }).count).toBe(2)

    const completed = handleJobApiRequest(engine, "GET", "/jobs", { status: "COMPLETED" })
    expect((completed.json as { count: number }).count).toBe(1)

    const sim = handleJobApiRequest(engine, "GET", "/jobs", { type: "SIMULATION" })
    expect((sim.json as { count: number }).count).toBe(1)

    const byTx = handleJobApiRequest(engine, "GET", "/jobs", { txHash: TX })
    expect((byTx.json as { count: number }).count).toBe(2)
  })

  it("rejects unknown status and type filters with 400", function () {
    expect(handleJobApiRequest(seedEngine(), "GET", "/jobs", { status: "DONE" }).status).toBe(400)
    expect(handleJobApiRequest(seedEngine(), "GET", "/jobs", { type: "AUTOML" }).status).toBe(400)
  })

  it("exposes per-job detail and failure state", function () {
    const engine = seedEngine()
    const job = deadLettered(engine)
    const detail = handleJobApiRequest(engine, "GET", `/jobs/${job.id}`)
    expect(detail.status).toBe(200)
    const body = detail.json as { job: Job }
    expect(body.job.status).toBe("DEAD_LETTER")
    expect(body.job.lastError).toBe("anvil down again")
    expect(body.job.retryHistory.map((entry) => entry.error)).toEqual(["anvil down", "anvil down again"])
    expect(body.job.txHash).toBe(TX)
  })

  it("returns 404 for unknown jobs", function () {
    expect(handleJobApiRequest(seedEngine(), "GET", "/jobs/nope").status).toBe(404)
  })

  it("exposes the audit event trail per job", function () {
    const engine = seedEngine()
    const job = deadLettered(engine)
    const events = handleJobApiRequest(engine, "GET", `/jobs/${job.id}/events`)
    expect(events.status).toBe(200)
    expect((events.json as { events: Array<{ type: string }> }).events.map((event) => event.type)).toEqual([
      "created",
      "claimed",
      "retrying",
      "claimed",
      "dead_lettered",
    ])
  })

  it("replays a dead-lettered job through the endpoint", function () {
    const engine = seedEngine()
    const job = deadLettered(engine)
    const replayed = handleJobApiRequest(engine, "POST", `/jobs/${job.id}/replay`)
    expect(replayed.status).toBe(200)
    expect((replayed.json as { job: Job }).job.status).toBe("QUEUED")
    expect((replayed.json as { job: Job }).job.attemptCount).toBe(0)
  })

  it("conflicts on impossible transitions instead of guessing", function () {
    const engine = seedEngine()
    const completed = engine.listJobs({ status: "COMPLETED" })[0]
    const replayed = handleJobApiRequest(engine, "POST", `/jobs/${completed.id}/replay`)
    expect(replayed.status).toBe(409)
  })

  it("404s unknown routes", function () {
    expect(handleJobApiRequest(seedEngine(), "GET", "/nope").status).toBe(404)
  })
})

describe("job status server (real HTTP)", function () {
  it("serves /health and /jobs over the wire", async function () {
    const engine = seedEngine()
    const server = await startJobStatusServer(engine, 0)
    try {
      const health = await fetch(`${server.url}/health`)
      expect(health.status).toBe(200)
      expect((await health.json()) as { ok: boolean }).toEqual({ ok: true })

      const jobs = await fetch(`${server.url}/jobs?status=COMPLETED`)
      expect(jobs.status).toBe(200)
      expect(((await jobs.json()) as { count: number }).count).toBe(1)

      const bad = await fetch(`${server.url}/jobs?type=SKYNET`)
      expect(bad.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
