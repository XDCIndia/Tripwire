import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import { createReconcileApi, startReconcileServer } from "../src/reconcileApi.js"
import { type ReconcileChainReader, ReconciliationService } from "../src/reconcileService.js"
import { createInMemoryReconcileStore } from "../src/reconcileStore.js"
import type { ChainStateSnapshot } from "../src/reconcileTypes.js"
import { RiskStatus, type RiskStatusValue } from "../src/verdict.js"

const START = 1_700_000_000_000

function chainState(status: RiskStatusValue): ChainStateSnapshot {
  return {
    registryVerdict: { status, score: 90, releaseAt: 0 },
    guard: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
    execution: { kind: "none" },
  }
}

function readerFor(states: Record<string, ChainStateSnapshot>): ReconcileChainReader {
  return {
    async readState(safeTxHash) {
      const state = states[safeTxHash]
      if (!state) throw new Error(`no state for ${safeTxHash}`)
      return state
    },
  }
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(function () {
  for (const server of servers.splice(0)) server.close()
})

describe("reconcile API handlers", function () {
  it("health reports store size and ok status", function () {
    const service = new ReconciliationService(createInMemoryReconcileStore(), {
      reader: readerFor({}),
      now: () => START,
    })
    const api = createReconcileApi(service)
    const response = api.health()
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.data).toMatchObject({ status: "ok", records: 0 })
    }
  })

  it("lists records with a validated status filter", function () {
    const states = { "0xabc": chainState(RiskStatus.HIGH_RISK) }
    const service = new ReconciliationService(createInMemoryReconcileStore(), {
      reader: readerFor(states),
      now: () => START,
    })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: { status: RiskStatus.HIGH_RISK, score: 90, releaseAt: 0 },
      value: 1_000n,
      guardAtSubmit: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
    })
    const api = createReconcileApi(service)

    const all = api.listRecords({})
    expect(all.ok).toBe(true)
    if (all.ok) expect((all.data as unknown[]).length).toBe(1)

    const pending = api.listRecords({ status: "PENDING" })
    expect(pending.ok).toBe(true)

    const bogus = api.listRecords({ status: "CONFIRMED" })
    expect(bogus.ok).toBe(false)
    if (!bogus.ok) expect(bogus.error).toContain("unknown status filter")
  })

  it("404s unknown records and serves their immutable history", async function () {
    const states = { "0xabc": chainState(RiskStatus.HIGH_RISK) }
    const service = new ReconciliationService(createInMemoryReconcileStore(), {
      reader: readerFor(states),
      now: () => START,
    })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: { status: RiskStatus.HIGH_RISK, score: 90, releaseAt: 0 },
      value: 1_000n,
      guardAtSubmit: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
    })
    const api = createReconcileApi(service)

    expect(api.getRecord("0xnope").ok).toBe(false)
    expect(api.getRecord("0xabc").ok).toBe(true)
    const history = api.getHistory("0xabc")
    expect(history.ok).toBe(true)
    if (history.ok) expect((history.data as unknown[]).map((e) => (e as { kind: string }).kind)).toEqual(["recorded"])
  })

  it("runs an immediate check through the API and surfaces the result", async function () {
    const states = { "0xabc": chainState(RiskStatus.LOW_RISK) }
    const service = new ReconciliationService(createInMemoryReconcileStore(), {
      reader: readerFor(states),
      now: () => START,
    })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: { status: RiskStatus.HIGH_RISK, score: 90, releaseAt: 0 },
      value: 1_000n,
      guardAtSubmit: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
    })
    const api = createReconcileApi(service)

    // Registry was rewritten to LOW_RISK between record and check -> MISMATCH.
    const response = await api.check("0xabc")
    expect(response.ok).toBe(true)
    if (response.ok) {
      const data = response.data as { result: { status: string; critical: boolean } }
      expect(data.result.status).toBe("MISMATCH")
      expect(data.result.critical).toBe(true)
    }

    const unknown = await api.check("0xnope")
    expect(unknown.ok).toBe(false)
  })
})

describe("reconcile HTTP server", function () {
  it("serves health and records over HTTP", async function () {
    const states: Record<string, ChainStateSnapshot> = {
      "0xabc": {
        registryVerdict: { status: RiskStatus.LOW_RISK, score: 20, releaseAt: 0 },
        guard: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
        // The approved transaction already executed, so a check confirms MATCH.
        execution: { kind: "success" },
      },
    }
    const service = new ReconciliationService(createInMemoryReconcileStore(), {
      reader: readerFor(states),
      now: () => START,
    })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: { status: RiskStatus.LOW_RISK, score: 20, releaseAt: 0 },
      value: 1_000n,
      guardAtSubmit: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
    })

    const server = startReconcileServer({ service, port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once("listening", () => resolve()))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`

    const health = await fetch(`${base}/reconcile/health`)
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as { data: { status: string } }
    expect(healthBody.data.status).toBe("ok")

    const records = await fetch(`${base}/reconcile/records`)
    expect(records.status).toBe(200)
    const list = (await records.json()) as { ok: boolean; data: unknown[] }
    expect(list.data).toHaveLength(1)

    const missing = await fetch(`${base}/reconcile/records/0xnope`)
    expect(missing.status).toBe(404)

    const bogusFilter = await fetch(`${base}/reconcile/records?status=CONFIRMED`)
    expect(bogusFilter.status).toBe(400)

    const check = await fetch(`${base}/reconcile/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: "0xabc" }),
    })
    expect(check.status).toBe(200)
    const checked = (await check.json()) as { data: { result: { status: string } } }
    expect(checked.data.result.status).toBe("MATCH")
  })
})
