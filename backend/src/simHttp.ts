import { createServer, type Server, type ServerResponse } from "node:http"

import type { SimulationDiff } from "./simulate.js"
import type { SimulationSignals } from "./simulationSignals.js"

/**
 * Read-only window into the pipeline's latest fork simulations (issue #44
 * acceptance criterion: "display the detected state changes in the guardian
 * dashboard"). Deliberately zero-dependency: `node:http` plus an in-memory
 * ring buffer - the backend is a watcher process, not a web service, and
 * this stays out of the scoring path entirely (the dashboard can burn down
 * without ever affecting a verdict).
 *
 * Endpoints:
 *   GET /health               -> { ok: true }
 *   GET /simulations/latest   -> newest-first array of recorded simulations
 *
 * Bigints are serialized as decimal strings; the frontend types mirror this.
 */

export interface RecordedSimulation {
  txHash: string
  safe: string
  to: string
  at: string
  diff: SimulationDiff | undefined
  signals: SimulationSignals
}

export interface SimulationStore {
  record(entry: RecordedSimulation): void
  latest(limit?: number): RecordedSimulation[]
}

export function createSimulationStore(capacity = 50): SimulationStore {
  const entries: RecordedSimulation[] = []
  return {
    record(entry) {
      entries.unshift(entry)
      if (entries.length > capacity) entries.length = capacity
    },
    latest(limit = entries.length) {
      return entries.slice(0, limit)
    },
  }
}

/** JSON.stringify that emits bigints as decimal strings instead of throwing. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = serialize(body)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(payload)
}

export function createSimHttpServer(store: SimulationStore): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === "GET" && url.pathname === "/simulations/latest") {
      const limit = Number(url.searchParams.get("limit") ?? 10)
      sendJson(res, 200, store.latest(Number.isFinite(limit) && limit > 0 ? limit : 10))
      return
    }
    sendJson(res, 404, { error: "not found" })
  })
}
