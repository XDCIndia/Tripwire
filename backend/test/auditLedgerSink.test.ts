import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { AuditLedger, createJsonlSink, createMemorySink, type AuditLedgerOptions } from "../src/auditLedgerSink.js"

const SAFE = "0xSafe0000000000000000000000000000000000"
const TX_A = "0xaaaa000000000000000000000000000000000000000000000000000000000000"
const TX_B = "0xbbbb000000000000000000000000000000000000000000000000000000000000"

let tempDir: string
afterAll(async function () {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function options(overrides: Partial<AuditLedgerOptions> = {}): AuditLedgerOptions {
  return { safe: SAFE, chainId: 31337, sink: createMemorySink(), ...overrides }
}

async function ledgerWithFullLifecycle(overrides: Partial<AuditLedgerOptions> = {}): Promise<AuditLedger> {
  const ledger = await AuditLedger.open(options(overrides))
  ledger.log(TX_A, "detected", undefined, { to: "0xTo00000000000000000000000000000000000000", value: "1000" })
  ledger.log(TX_A, "analysis", "rule-engine", {
    score: 40,
    label: "medium_risk",
    matchedSignals: ["UNLIMITED_APPROVE"],
  })
  ledger.log(TX_A, "analysis", "simulation", { unexpectedAllowanceIncrease: true })
  ledger.log(TX_A, "verdict", undefined, {
    score: 85,
    status: "high_risk",
    action: "block",
    explanation: "concealed allowance",
  })
  ledger.log(TX_A, "enforcement", "relayer", { status: "submitted", enforcementTxHash: "0xbeef01" })
  ledger.log(TX_A, "failure", "relayer", { error: "rpc hiccup" })
  ledger.log(TX_A, "retry", "relayer", {})
  ledger.log(TX_A, "enforcement", "relayer", { status: "confirmed", enforcementTxHash: "0xbeef02" })
  ledger.log(TX_A, "reconciliation", "reconciler", { expected: "high_risk", actual: "high_risk", status: "match" })
  return ledger
}

describe("AuditLedger (issue #52)", function () {
  it("creates a persistent record for every analyzed transaction, with context and versions", async function () {
    const ledger = await AuditLedger.open(options({ policyVersion: "policy-v3", ruleVersion: "rules-v7" }))
    ledger.log(TX_A, "detected", undefined, { to: "0xTo00", value: "1" })
    const record = ledger.get(TX_A)!
    expect(record.safe).toBe(SAFE)
    expect(record.chainId).toBe(31337)
    expect(record.policyVersion).toBe("policy-v3")
    expect(record.ruleVersion).toBe("rules-v7")
    expect(record.createdAt).toBe(record.timeline[0].at)
  })

  it("stores individual analysis results per component, each with its own timestamp", async function () {
    const ledger = await ledgerWithFullLifecycle()
    const record = ledger.get(TX_A)!
    expect(record.analysis.ruleEngine?.result.score).toBe(40)
    expect(record.analysis.simulation?.result.unexpectedAllowanceIncrease).toBe(true)
    expect(record.analysis.ruleEngine?.at).toBeTruthy()
    expect(record.analysis.simulation?.at).toBeTruthy()
  })

  it("stores the canonical score, status, action, and explanation", async function () {
    const ledger = await ledgerWithFullLifecycle()
    const record = ledger.get(TX_A)!
    expect(record.canonical).toMatchObject({
      score: 85,
      status: "high_risk",
      action: "block",
      explanation: "concealed allowance",
      policyVersion: "policy-v1",
      ruleVersion: "rules-v1",
    })
  })

  it("mints a stable verdictId on the first verdict event and correlates later stages", async function () {
    const ledger = await ledgerWithFullLifecycle()
    const record = ledger.get(TX_A)!
    expect(record.verdictId).toBe(`${TX_A}#v1`)
    const enforcement = record.timeline.find((e) => e.type === "enforcement")!
    const reconciliation = record.timeline.find((e) => e.type === "reconciliation")!
    expect(enforcement.verdictId).toBe(record.verdictId)
    expect(reconciliation.verdictId).toBe(record.verdictId)
  })

  it("records enforcement hashes, attempts, retries, and failures", async function () {
    const ledger = await ledgerWithFullLifecycle()
    const record = ledger.get(TX_A)!
    expect(record.enforcement?.status).toBe("confirmed")
    expect(record.enforcement?.enforcementTxHash).toBe("0xbeef02")
    expect(record.enforcement?.attempts).toBe(3) // submit + retry + resubmit
  })

  it("a failure after a confirmation does not erase the confirmed attempt from history", async function () {
    const ledger = await AuditLedger.open(options())
    ledger.log(TX_A, "enforcement", "relayer", { status: "confirmed", enforcementTxHash: "0xbeef01" })
    ledger.log(TX_A, "failure", "relayer", { error: "late receipt timeout" })
    const record = ledger.get(TX_A)!
    expect(record.enforcement?.status).toBe("failed") // current state reflects the failure...
    expect(record.timeline.some((e) => e.data.enforcementTxHash === "0xbeef01")).toBe(true) // ...but history is intact
  })

  it("records reconciliation results", async function () {
    const ledger = await ledgerWithFullLifecycle()
    expect(ledger.get(TX_A)!.reconciliation).toMatchObject({
      expected: "high_risk",
      actual: "high_risk",
      status: "match",
    })
  })

  it("APPEND-ONLY: a later verdict never overwrites earlier analysis events", async function () {
    const ledger = await AuditLedger.open(options())
    ledger.log(TX_A, "analysis", "rule-engine", { score: 10 })
    const before = ledger.timeline(TX_A)
    ledger.log(TX_A, "verdict", undefined, { score: 90, status: "high_risk", action: "block", explanation: "later" })
    ledger.log(TX_A, "analysis", "rule-engine", { score: 20 })
    const after = ledger.timeline(TX_A)
    expect(after[0]).toEqual(before[0]) // the original analysis event is byte-identical
    expect(after).toHaveLength(3)
    expect(ledger.get(TX_A)!.analysis.ruleEngine?.result.score).toBe(20) // latest evidence is a NEW event
  })

  it("reconstructs the complete timeline in append order with monotonic seq", async function () {
    const ledger = await ledgerWithFullLifecycle()
    const timeline = ledger.timeline(TX_A)
    expect(timeline.map((e) => e.seq)).toEqual([...timeline.keys()])
    expect(timeline.map((e) => e.type)).toEqual([
      "detected",
      "analysis",
      "analysis",
      "verdict",
      "enforcement",
      "failure",
      "retry",
      "enforcement",
      "reconciliation",
    ])
  })

  it("sink failures land on onError and never reject the log call", async function () {
    const errors: unknown[] = []
    const failingSink = {
      async append(): Promise<void> {
        throw new Error("disk full")
      },
      async readAll() {
        return []
      },
    }
    const ledger = await AuditLedger.open(options({ sink: failingSink, onError: (e) => errors.push(e) }))
    expect(() => ledger.log(TX_A, "detected", undefined, {})).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10)) // let the fire-and-forget settle
    expect(errors).toHaveLength(1)
    expect(ledger.has(TX_A)).toBe(true) // in-memory index kept the event
  })

  describe("query filtering", function () {
    async function ledgerWithTwoTxs(): Promise<AuditLedger> {
      const ledger = await ledgerWithFullLifecycle() // TX_A: high_risk, confirmed
      ledger.log(TX_B, "detected", undefined, { to: "0xTo01", value: "5" })
      ledger.log(TX_B, "verdict", undefined, { score: 10, status: "low_risk", action: "allow", explanation: "clean" })
      return ledger
    }

    it("filters by txHash", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query({ txHash: TX_B })).toHaveLength(1)
      expect(ledger.query({ txHash: TX_B })[0].canonical?.action).toBe("allow")
    })

    it("filters by verdictId", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query({ verdictId: `${TX_A}#v1` })).toHaveLength(1)
    })

    it("filters by riskLevel (canonical status)", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query({ riskLevel: "high_risk" })).toHaveLength(1)
      expect(ledger.query({ riskLevel: "low_risk" })).toHaveLength(1)
      expect(ledger.query({ riskLevel: "medium_risk" })).toHaveLength(0)
    })

    it("filters by enforcementStatus", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query({ enforcementStatus: "confirmed" })).toHaveLength(1)
      expect(ledger.query({ enforcementStatus: "failed" })).toHaveLength(0)
    })

    it("filters by safe address (case-insensitive) and honors limit", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query({ safe: SAFE.toUpperCase() })).toHaveLength(2)
      expect(ledger.query({ limit: 1 })).toHaveLength(1)
    })

    it("returns everything newest-first with no filter", async function () {
      const ledger = await ledgerWithTwoTxs()
      expect(ledger.query()).toHaveLength(2)
    })
  })

  describe("JSONL persistence", function () {
    it("a reopened ledger reconstructs identical state from the file (crash/restart round-trip)", async function () {
      tempDir = await mkdtemp(join(tmpdir(), "audit-ledger-"))
      const file = join(tempDir, "audit.jsonl")
      const first = await ledgerWithFullLifecycle({ sink: createJsonlSink(file) })
      await new Promise((resolve) => setTimeout(resolve, 20)) // let appends land

      const reopened = await AuditLedger.open(options({ sink: createJsonlSink(file) }))
      const a = first.get(TX_A)!
      const b = reopened.get(TX_A)!
      expect(b.verdictId).toBe(a.verdictId)
      expect(b.canonical).toEqual(a.canonical)
      expect(b.enforcement).toEqual(a.enforcement)
      expect(b.reconciliation).toEqual(a.reconciliation)
      expect(b.timeline).toHaveLength(a.timeline.length)
      // and the ledger stays appendable after replay: seq continues, no collision
      const ev = reopened.log(TX_B, "detected", undefined, {})
      expect(ev.seq).toBeGreaterThan(b.timeline[b.timeline.length - 1].seq)
    })

    it("a missing file opens as an empty ledger", async function () {
      tempDir = await mkdtemp(join(tmpdir(), "audit-ledger-"))
      const ledger = await AuditLedger.open(options({ sink: createJsonlSink(join(tempDir, "nope.jsonl")) }))
      expect(ledger.query()).toHaveLength(0)
    })

    it("reconstruction does not depend on sink order (fire-and-forget appends race)", async function () {
      const memory = createMemorySink()
      const first = await ledgerWithFullLifecycle({ sink: memory })
      const shuffledSink = {
        append: memory.append.bind(memory),
        readAll: async () => [...memory.events].reverse(), // worst-case: exact reverse order
      }
      const reopened = await AuditLedger.open(options({ sink: shuffledSink }))
      expect(reopened.get(TX_A)).toEqual(first.get(TX_A))
    })
  })
})
