import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import type { SimulationDiff } from "../src/simulate.js"
import { NO_SIMULATION_SIGNALS } from "../src/simulationSignals.js"
import { createSimHttpServer, createSimulationStore, type RecordedSimulation } from "../src/simHttp.js"

const SAFE = "0xSafe0000000000000000000000000000000000"
const TO = "0xTo00000000000000000000000000000000000000"

function entry(txHash: string, over: Partial<RecordedSimulation> = {}): RecordedSimulation {
  const diff: SimulationDiff = {
    balanceBefore: 10n ** 18n,
    balanceAfter: 9n * 10n ** 17n,
    newAllowances: [
      {
        token: "0xToken0000000000000000000000000000000000",
        spender: "0xSpender00000000000000000000000000000000",
        standard: "erc20",
        before: 0n,
        after: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      },
    ],
    ownershipChanges: [],
    success: true,
  }
  return {
    txHash,
    safe: SAFE,
    to: TO,
    at: new Date(0).toISOString(),
    diff,
    signals: NO_SIMULATION_SIGNALS,
    ...over,
  }
}

describe("simHttp (dashboard read endpoint)", function () {
  let server: Server
  let baseUrl: string

  beforeAll(async function () {
    const store = createSimulationStore(10)
    store.record(entry("0xaaa"))
    store.record(entry("0xbbb", { diff: undefined, signals: { ...NO_SIMULATION_SIGNALS, simulationFailed: true } }))
    server = createSimHttpServer(store)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address === "string" || address === null) throw new Error("no address")
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve))
  })

  it("GET /health responds ok", async function () {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("GET /simulations/latest returns newest first with bigints as decimal strings", async function () {
    const res = await fetch(`${baseUrl}/simulations/latest`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      txHash: string
      diff: {
        balanceBefore: string
        balanceAfter: string
        newAllowances: Array<{ before: string; after: string }>
      } | null
      signals: { simulationFailed: boolean }
    }>

    expect(body).toHaveLength(2)
    expect(body[0].txHash).toBe("0xbbb") // newest first
    expect(body[0].diff).toBeUndefined() // JSON drops undefined: failed sim carries no diff, signals say why
    expect(body[0].signals.simulationFailed).toBe(true)

    const older = body[1]
    expect(older.txHash).toBe("0xaaa")
    expect(typeof older.diff?.balanceBefore).toBe("string")
    expect(older.diff?.balanceBefore).toBe((10n ** 18n).toString())
    expect(older.diff?.newAllowances[0].after).toBe(
      115792089237316195423570985008687907853269984665640564039457584007913129639935n.toString(),
    )
  })

  it("honors the limit query param", async function () {
    const res = await fetch(`${baseUrl}/simulations/latest?limit=1`)
    const body = (await res.json()) as unknown[]
    expect(body).toHaveLength(1)
  })

  it("404s unknown paths", async function () {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  it("the store caps at capacity", function () {
    const store = createSimulationStore(2)
    store.record(entry("0x1"))
    store.record(entry("0x2"))
    store.record(entry("0x3"))
    const latest = store.latest()
    expect(latest.map((e) => e.txHash)).toEqual(["0x3", "0x2"])
  })
})
