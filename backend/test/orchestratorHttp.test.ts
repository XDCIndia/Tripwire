import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import { createOrchestratorHttpServer } from "../src/orchestratorHttp.js"
import { RiskOrchestrator, createMemoryStateStore, type ProcessingStatus } from "../src/riskOrchestrator.js"

describe("orchestratorHttp (issue #45: intake + status API)", function () {
  let server: Server
  let baseUrl: string
  let orchestrator: RiskOrchestrator

  beforeAll(async function () {
    orchestrator = RiskOrchestrator.create({
      relayer: { async submit() {} },
      store: createMemoryStateStore(),
      simulation: { analyze: async () => ({ points: 15, reasons: ["wallet anomaly"] }) },
      sleep: () => Promise.resolve(),
    })
    server = createOrchestratorHttpServer(orchestrator)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address === "string" || address === null) throw new Error("no address")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve))
  })

  async function propose(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/tx/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  async function waitFor(txHash: string, statuses: ProcessingStatus[], timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const res = await fetch(`${baseUrl}/tx/${txHash}/status`)
      if (res.ok) {
        const state = (await res.json()) as { status: string }
        if (statuses.includes(state.status as ProcessingStatus)) return state.status
      }
      if (Date.now() > deadline) throw new Error("timeout")
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it("GET /health reports queue depth", async function () {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it("POST /tx/propose accepts a proposed Safe tx and derives a stable content hash when txHash is omitted", async function () {
    const body = { to: "0xTo00000000000000000000000000000000000000", value: "1000", data: "0x" }
    const first = await propose(body)
    expect(first.status).toBe(202)
    const firstJson = (await first.json()) as { txHash: string; status: string; duplicate: boolean }
    expect(firstJson.duplicate).toBe(false)

    const second = await propose(body) // identical proposal
    const secondJson = (await second.json()) as { txHash: string; duplicate: boolean }
    expect(secondJson.txHash).toBe(firstJson.txHash) // content-addressed dedupe
    await waitFor(firstJson.txHash, ["submitted"])
  })

  it("GET /tx/:txHash/status exposes the canonical verdict for the dashboard", async function () {
    const res = await propose({
      txHash: "0xcccc000000000000000000000000000000000000000000000000000000000000",
      to: "0xTo00000000000000000000000000000000000000",
      value: "0",
      data: `0x095ea7b3${"abcdefabcdefabcdefabcdefabcdefabcdefabcd".padStart(64, "0")}${"f".repeat(64)}`,
    })
    const { txHash } = (await res.json()) as { txHash: string }
    await waitFor(txHash, ["submitted"])
    const status = (await (await fetch(`${baseUrl}/tx/${txHash}/status`)).json()) as {
      status: string
      canonical: { score: number; status: string; action: string; explanation: string }
    }
    expect(status.status).toBe("submitted")
    expect(status.canonical.score).toBe(55) // 40 unlimited approve + 15 simulation
    expect(status.canonical.action).toBe("delay")
    expect(status.canonical.explanation).toContain("wallet anomaly")
  })

  it("GET /tx lists states with status filter and limit", async function () {
    const all = (await (await fetch(`${baseUrl}/tx`)).json()) as unknown[]
    expect(all.length).toBeGreaterThanOrEqual(2)
    const limited = (await (await fetch(`${baseUrl}/tx?limit=1`)).json()) as unknown[]
    expect(limited).toHaveLength(1)
    const submitted = (await (await fetch(`${baseUrl}/tx?status=submitted`)).json()) as Array<{ status: string }>
    expect(submitted.every((s) => s.status === "submitted")).toBe(true)
  })

  it("validates input and 404s unknown txs and paths", async function () {
    const bad = await propose({ to: "0xTo00" }) // missing value/data
    expect(bad.status).toBe(400)
    const notJson = await fetch(`${baseUrl}/tx/propose`, { method: "POST", body: "nope{" })
    expect(notJson.status).toBe(400)
    const missing = await fetch(`${baseUrl}/tx/0xdead/status`)
    expect(missing.status).toBe(404)
    const nopath = await fetch(`${baseUrl}/nope`)
    expect(nopath.status).toBe(404)
  })
})
