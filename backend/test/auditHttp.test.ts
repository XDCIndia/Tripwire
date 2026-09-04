import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import { AuditLedger, createMemorySink } from "../src/auditLedgerSink.js"
import { createAuditHttpServer } from "../src/auditHttp.js"

const SAFE = "0xSafe0000000000000000000000000000000000"
const TX_A = "0xaaaa000000000000000000000000000000000000000000000000000000000000"
const TX_B = "0xbbbb000000000000000000000000000000000000000000000000000000000000"

describe("auditHttp (issue #52: audit history API)", function () {
  let server: Server
  let baseUrl: string

  beforeAll(async function () {
    const ledger = await AuditLedger.open({ safe: SAFE, chainId: 31337, sink: createMemorySink() })
    ledger.log(TX_A, "detected", undefined, { to: "0xTo00", value: "1" })
    ledger.log(TX_A, "analysis", "rule-engine", { score: 85 })
    ledger.log(TX_A, "verdict", undefined, {
      score: 85,
      status: "high_risk",
      action: "block",
      explanation: "concealed allowance",
    })
    ledger.log(TX_A, "enforcement", "relayer", { status: "confirmed", enforcementTxHash: "0xbeef01" })
    ledger.log(TX_A, "reconciliation", "reconciler", { expected: "high_risk", actual: "high_risk", status: "match" })
    ledger.log(TX_B, "detected", undefined, { to: "0xTo01", value: "5" })
    ledger.log(TX_B, "verdict", undefined, { score: 10, status: "low_risk", action: "allow", explanation: "clean" })

    server = createAuditHttpServer(ledger)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address === "string" || address === null) throw new Error("no address")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve))
  })

  it("GET /audit/health responds ok", async function () {
    const res = await fetch(`${baseUrl}/audit/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("GET /audit returns all records with canonical decisions", async function () {
    const res = await fetch(`${baseUrl}/audit`)
    const body = (await res.json()) as Array<{ txHash: string; canonical?: { action: string } }>
    expect(body).toHaveLength(2)
  })

  it("filters by riskLevel", async function () {
    const res = await fetch(`${baseUrl}/audit?riskLevel=high_risk`)
    const body = (await res.json()) as Array<{ txHash: string }>
    expect(body).toHaveLength(1)
    expect(body[0].txHash).toBe(TX_A)
  })

  it("filters by enforcementStatus", async function () {
    const confirmed = (await (await fetch(`${baseUrl}/audit?enforcementStatus=confirmed`)).json()) as unknown[]
    const failed = (await (await fetch(`${baseUrl}/audit?enforcementStatus=failed`)).json()) as unknown[]
    expect(confirmed).toHaveLength(1)
    expect(failed).toHaveLength(0)
  })

  it("filters by txHash and verdictId", async function () {
    const byTx = (await (await fetch(`${baseUrl}/audit?txHash=${TX_B}`)).json()) as Array<{ txHash: string }>
    expect(byTx).toHaveLength(1)
    const byVerdict = (await (await fetch(`${baseUrl}/audit?verdictId=${TX_A}%23v1`)).json()) as Array<{
      txHash: string
    }>
    expect(byVerdict).toHaveLength(1)
    expect(byVerdict[0].txHash).toBe(TX_A)
  })

  it("filters by safe address and honors limit", async function () {
    const all = (await (await fetch(`${baseUrl}/audit?safe=${SAFE.toUpperCase()}`)).json()) as unknown[]
    expect(all).toHaveLength(2)
    const limited = (await (await fetch(`${baseUrl}/audit?limit=1`)).json()) as unknown[]
    expect(limited).toHaveLength(1)
  })

  it("GET /audit/timeline/:txHash returns the full un-overwritten timeline", async function () {
    const res = await fetch(`${baseUrl}/audit/timeline/${TX_A}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      txHash: string
      record: { verdictId: string; canonical: { score: number } }
      timeline: Array<{ type: string; seq: number; verdictId?: string }>
    }
    expect(body.timeline.map((e) => e.type)).toEqual([
      "detected",
      "analysis",
      "verdict",
      "enforcement",
      "reconciliation",
    ])
    expect(body.record.canonical.score).toBe(85)
    expect(body.timeline[2].verdictId).toBe(`${TX_A}#v1`)
    expect(body.timeline[3].verdictId).toBe(`${TX_A}#v1`) // enforcement correlated
  })

  it("unknown tx timeline 404s; unknown paths 404", async function () {
    const missing = await fetch(`${baseUrl}/audit/timeline/0xdead`)
    expect(missing.status).toBe(404)
    const nopath = await fetch(`${baseUrl}/nope`)
    expect(nopath.status).toBe(404)
  })
})
