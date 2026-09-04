import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import type { RuleEngineResult } from "../src/ruleEngine.js"
import {
  RiskOrchestrator,
  createJsonlStateStore,
  createMemoryStateStore,
  type ProposedTx,
  type ProcessingStatus,
  type ScoreContribution,
} from "../src/riskOrchestrator.js"

const TX_A = "0xaaaa000000000000000000000000000000000000000000000000000000000000"
const TX_B = "0xbbbb000000000000000000000000000000000000000000000000000000000000"

const pad32 = (hex: string): string => hex.padStart(64, "0")
const UNLIMITED_APPROVE = `0x095ea7b3${pad32("abcdefabcdefabcdefabcdefabcdefabcdefabcd")}${"f".repeat(64)}`

let tempDir: string
afterAll(async function () {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function tx(txHash: string, data = "0x", value = 0n): ProposedTx {
  return { txHash, to: "0xTo00000000000000000000000000000000000000", value, data }
}

function okRelayer(log: Array<{ txHash: string; verdict?: RuleEngineResult }> = []) {
  return {
    async submit(txHash: string, verdict: RuleEngineResult) {
      log.push({ txHash, verdict })
    },
  }
}

const noSleep = () => Promise.resolve()

async function waitForStatus(
  orchestrator: RiskOrchestrator,
  txHash: string,
  statuses: ProcessingStatus[],
  timeoutMs = 2000,
): Promise<NonNullable<Awaited<ReturnType<RiskOrchestrator["status"]>>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await orchestrator.status(txHash)
    if (state && statuses.includes(state.status)) return state
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${statuses.join("/")} (last: ${state?.status})`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("RiskOrchestrator (issue #45)", function () {
  it("produces one canonical verdict (score, status, action, explanation) correlated by tx hash", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      simulation: { analyze: async () => ({ points: 20, reasons: ["wallet anomaly"] }) },
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A, UNLIMITED_APPROVE))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])

    const v = state.canonical!
    expect(v.txHash).toBe(TX_A)
    expect(v.score).toBe(60) // 40 unlimited approve + 20 sim
    expect(v.status).toBe("medium_risk")
    expect(v.action).toBe("delay")
    expect(v.explanation).toContain("[rule-engine]")
    expect(v.explanation).toContain("[simulation]")
    expect(v.contributions).toHaveLength(2)
  })

  it("duplicates do not create duplicate verdicts: the second propose returns the existing one", async function () {
    const submitted: Array<{ txHash: string }> = []
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(submitted),
      store: createMemoryStateStore(),
      sleep: noSleep,
    })
    const first = await orchestrator.propose(tx(TX_A))
    await waitForStatus(orchestrator, TX_A, ["submitted"])
    const second = await orchestrator.propose(tx(TX_A))
    await new Promise((r) => setTimeout(r, 30)) // let any misdirected reprocess settle

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.canonical?.txHash).toBe(TX_A)
    expect(submitted).toHaveLength(1) // exactly one on-chain submission
  })

  it("aggregates all components and caps the score at 100", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      simulation: { analyze: async () => ({ points: 70, reasons: ["sim risk"] }) }, // 40 + 70 = 110 -> capped
      llm: { assess: async () => undefined },
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A, UNLIMITED_APPROVE))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(state.canonical!.score).toBe(100)
    expect(state.canonical!.status).toBe("high_risk")
    expect(state.canonical!.action).toBe("block")
  })

  it("a low-risk tx with no component findings is ALLOW with an empty-signal explanation", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(state.canonical).toMatchObject({ score: 0, status: "low_risk", action: "allow" })
    expect(state.canonical!.explanation).toBe("no risk signals fired")
  })

  it("retries a flaky component without losing state, then succeeds", async function () {
    let calls = 0
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      simulation: {
        analyze: async (): Promise<ScoreContribution> => {
          calls += 1
          if (calls < 3) throw new Error(`flaky (${calls})`)
          return { points: 10, reasons: ["recovered"] }
        },
      },
      componentRetries: 3,
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(calls).toBe(3)
    expect(state.canonical!.score).toBe(10)
    expect(state.canonical!.explanation).toContain("recovered")
  })

  it("FAIL-SAFE: a critical component that stays down contributes elevation with a reason - the tx is still decided", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      simulation: {
        analyze: async (): Promise<ScoreContribution> => {
          throw new Error("anvil unreachable")
        },
      },
      componentRetries: 2,
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(state.canonical!.score).toBe(35)
    expect(state.canonical!.status).toBe("medium_risk") // elevated, never silent, never auto-approved below this
    expect(state.canonical!.explanation).toMatch(/unavailable.*never auto-approved/)
  })

  it("LLM failure is non-critical: the deterministic verdict stands", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      llm: {
        assess: async () => {
          throw new Error("claude down")
        },
      },
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(state.canonical!.score).toBe(0)
    expect(state.canonical!.status).toBe("low_risk")
  })

  it("submission failures retry on-chain and record every attempt in state", async function () {
    let attempts = 0
    const orchestrator = RiskOrchestrator.create({
      relayer: {
        async submit() {
          attempts += 1
          if (attempts < 3) throw new Error("nonce gap")
        },
      },
      store: createMemoryStateStore(),
      submissionRetries: 3,
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const state = await waitForStatus(orchestrator, TX_A, ["submitted"])
    expect(attempts).toBe(3)
    expect(state.attempts).toBe(3)
    expect(state.history.filter((h) => h.status === "submission_failed")).toHaveLength(2)
  })

  it("a tx exhausted to submission_failed resumes from persisted state on re-propose (no re-analysis)", async function () {
    let simCalls = 0
    let submitCalls = 0
    const store = createMemoryStateStore()
    const orchestrator = RiskOrchestrator.create({
      relayer: {
        async submit() {
          submitCalls += 1
          throw new Error("chain down")
        },
      },
      store,
      simulation: {
        analyze: async (): Promise<ScoreContribution> => {
          simCalls += 1
          return { points: 5, reasons: ["sim"] }
        },
      },
      submissionRetries: 1,
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    const failed = await waitForStatus(orchestrator, TX_A, ["submission_failed"])
    expect(failed.canonical).toBeDefined()

    // chain recovers; same tx proposed again
    let recoveredCalls = 0
    const recovered = RiskOrchestrator.create({
      relayer: {
        async submit() {
          recoveredCalls += 1
        },
      },
      store,
      submissionRetries: 1,
      sleep: noSleep,
    })
    const again = await recovered.propose(tx(TX_A))
    expect(again.duplicate).toBe(false)
    expect(again.canonical?.score).toBe(5) // verdict survived - no re-analysis
    expect(simCalls).toBe(1)
    const done = await waitForStatus(recovered, TX_A, ["submitted"])
    expect(done.canonical!.score).toBe(5)
    expect(recoveredCalls).toBe(1)
  })

  it("persisted state survives a restart: no duplicate verdict after reopening the store", async function () {
    tempDir = await mkdtemp(join(tmpdir(), "orch-"))
    const file = join(tempDir, "state.jsonl")
    const store = createJsonlStateStore(file)
    const submitted: Array<{ txHash: string }> = []
    const first = RiskOrchestrator.create({ relayer: okRelayer(submitted), store, sleep: noSleep })
    await first.propose(tx(TX_A, UNLIMITED_APPROVE))
    await waitForStatus(first, TX_A, ["submitted"])

    const reopened = RiskOrchestrator.create({
      relayer: okRelayer(submitted),
      store: createJsonlStateStore(file),
      sleep: noSleep,
    })
    const dup = await reopened.propose(tx(TX_A, UNLIMITED_APPROVE))
    await new Promise((r) => setTimeout(r, 30))
    expect(dup.duplicate).toBe(true)
    expect(dup.canonical?.score).toBe(40)
    expect(submitted).toHaveLength(1)
  })

  it("list() filters by status and honors limit", async function () {
    const orchestrator = RiskOrchestrator.create({
      relayer: okRelayer(),
      store: createMemoryStateStore(),
      sleep: noSleep,
    })
    await orchestrator.propose(tx(TX_A))
    await orchestrator.propose(tx(TX_B))
    await waitForStatus(orchestrator, TX_A, ["submitted"])
    await waitForStatus(orchestrator, TX_B, ["submitted"])
    expect(await orchestrator.list({ status: "submitted" })).toHaveLength(2)
    expect(await orchestrator.list({ limit: 1 })).toHaveLength(1)
  })
})
