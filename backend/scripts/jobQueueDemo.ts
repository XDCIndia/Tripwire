/**
 * Manual demo for the durable risk-analysis job queue (#55) - not part of
 * the automated suite, but a runnable walkthrough of the failure story the
 * issue is about:
 *
 *   one Safe transaction event -> four independent analysis jobs ->
 *   a flaky simulation that retries -> an LLM job that keeps failing ->
 *   dead-letter -> operator replay -> completed.
 *
 * Jobs are persisted to a real JSONL log (fsynced per transition), so the
 * run below also demonstrates that the queue survives a restart: the store
 * is reopened from disk at the end and the state is identical.
 *
 * Usage:
 *   npx tsx scripts/jobQueueDemo.ts            # full lifecycle walkthrough
 *   npx tsx scripts/jobQueueDemo.ts --serve    # also start the status API
 *
 * While --serve is running, inspect it from another terminal:
 *   curl http://127.0.0.1:8787/jobs
 *   curl http://127.0.0.1:8787/jobs?status=DEAD_LETTER
 *   curl http://127.0.0.1:8787/jobs/<id>/events
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { JobEngine } from "../src/jobEngine.js"
import { createJobWorker, type JobRunResult } from "../src/jobWorker.js"
import { createFileJobStore } from "../src/jobStore.js"
import { handleJobApiRequest, startJobStatusServer } from "../src/jobStatusApi.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A Safe transaction event just arrived from the watcher (issue #55's
 * "Indexer -> Orchestrator" entry point). */
const TX_EVENT = {
  txHash: "0x" + "ab".repeat(32),
  verdictId: "verdict-0xdead",
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "tripwire-jobqueue-"))
  const logFile = join(dir, "jobs.jsonl")
  console.log(`Job log: ${logFile}\n`)

  // Durable from the start: the store is a file, fsynced on every event.
  const engine = new JobEngine(createFileJobStore(logFile), {
    retry: { maxAttempts: 3, baseDelayMs: 120, maxDelayMs: 500 },
    leaseMs: 30_000,
  })

  // --- Indexer event -> durable jobs -------------------------------------
  console.log(`Transaction event detected: ${TX_EVENT.txHash.slice(0, 18)}…`)
  let failedOnce = false
  let llmCalls = 0
  const tasks = {
    RULES: async (job: { id: string }): Promise<JobRunResult> => ({
      resultRef: `audit://rules/${job.id}`,
      result: { matchedSignals: ["unlimited approve"], score: 40, label: "medium_risk" },
    }),
    WALLET_RISK: async (job: { id: string }): Promise<JobRunResult> => ({
      resultRef: `audit://wallet/${job.id}`,
      result: { firstSeen: false },
    }),
    SIMULATION: async (job: { id: string }): Promise<JobRunResult> => {
      if (!failedOnce) {
        failedOnce = true
        throw new Error("anvil fork is still warming up")
      }
      return { resultRef: `audit://sim/${job.id}`, result: { balanceDelta: "-12.5 XDC" } }
    },
    LLM: async (job: { id: string }): Promise<JobRunResult> => {
      llmCalls += 1
      // Down for the first three calls (dead-lettering this job), then back.
      if (llmCalls <= 3) throw new Error(`LLM provider unavailable (call ${llmCalls})`)
      return {
        resultRef: `audit://llm/${job.id}`,
        verdictId: TX_EVENT.verdictId,
        result: { score: 5, label: "low_risk" },
      }
    },
  } as const

  // Four independent jobs for the one event (idempotent enqueue).
  for (const analysisType of ["RULES", "WALLET_RISK", "SIMULATION", "LLM"] as const) {
    engine.enqueue({ txHash: TX_EVENT.txHash, analysisType, verdictId: TX_EVENT.verdictId })
  }
  const duplicate = engine.enqueue({ txHash: TX_EVENT.txHash, analysisType: "RULES" })
  console.log(`Jobs created: ${engine.listJobs().length} (re-delivering the event did not duplicate RULES: id ${duplicate.id})\n`)

  const worker = createJobWorker(engine, tasks, "worker-1")
  const serve = process.argv.includes("--serve")
  const statusServer = serve ? await startJobStatusServer(engine, 8787) : null
  if (statusServer) console.log(`Status API listening on ${statusServer.url} (Ctrl+C to stop)\n`)

  // --- Workers run; retries and dead letters happen ----------------------
  const cycles = 14
  for (let i = 0; i < cycles; i++) {
    await worker.runOnce()
    await sleep(160) // let the exponential backoff elapse between attempts
  }

  console.log("After workers ran:")
  for (const job of engine.listJobs()) {
    console.log(
      `  ${job.analysisType.padEnd(11)} ${job.status.padEnd(11)} attempts=${job.attemptCount}` +
        (job.lastError ? ` error="${job.lastError}"` : "") +
        (job.resultRef ? ` result=${job.resultRef}` : ""),
    )
  }

  // --- Dead-letter handling & recovery ------------------------------------
  const dead = engine.listJobs({ status: "DEAD_LETTER" })
  console.log(`\nDead-lettered: ${dead.length} (the LLM provider stayed down through all retries). Replaying…`)
  for (const job of dead) {
    engine.replay(job.id)
    await worker.runOnce()
    await sleep(160)
  }
  const replayed = engine.listJobs({ status: "DEAD_LETTER" })
  console.log(
    replayed.length === 0
      ? "All jobs completed after replay (the provider came back; attempt history is preserved)."
      : `Still dead-lettered: ${replayed.map((job) => job.id).join(", ")}`,
  )

  // --- Status + audit exposure ---------------------------------------------
  const response = handleJobApiRequest(engine, "GET", "/jobs")
  console.log(`\nStatus endpoint /jobs -> ${response.status} (${(response.json as { count: number }).count} jobs)`)
  const first = engine.listJobs()[0]
  const trail = handleJobApiRequest(engine, "GET", `/jobs/${first.id}/events`)
  console.log(`Audit trail for ${first.id}: ${(trail.json as { events: unknown[] }).events.map((event) => (event as { type: string }).type).join(" -> ")}`)

  // --- Durability: reopen from disk, state identical ----------------------
  const reopened = new JobEngine(createFileJobStore(logFile), { retry: { maxAttempts: 3 } })
  const before = engine.listJobs().map((job) => `${job.id}:${job.status}`).sort()
  const after = reopened.listJobs().map((job) => `${job.id}:${job.status}`).sort()
  console.log(`\nRestart recovery: reopened the log from disk -> state identical (${before.length === after.length && before.every((entry, i) => entry === after[i]) ? "yes" : "NO"})`)

  await statusServer?.close()
  engine.log.close()
  reopened.log.close()
  rmSync(dir, { recursive: true, force: true })
  console.log("Demo complete.")
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
