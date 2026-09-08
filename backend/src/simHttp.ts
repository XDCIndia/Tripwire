import { createServer, type Server, type ServerResponse } from "node:http"
import { pathToFileURL } from "node:url"

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

/** The dashboard is a different origin in dev (Vite :5173), so SimulationCard needs these. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = serialize(body)
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS })
  res.end(payload)
}

export function createSimHttpServer(store: SimulationStore): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
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

// ---------------------------------------------------------------------------
// Entrypoint - `npm run sim`
// ---------------------------------------------------------------------------

function startFromEnv(): void {
  const port = Number(process.env.SIM_PORT ?? 3003)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`SIM_PORT must be a valid port number, got: ${process.env.SIM_PORT}`)
    process.exit(1)
  }

  const capacity = Number(process.env.SIM_STORE_CAPACITY ?? 50)
  const store = createSimulationStore(Number.isFinite(capacity) && capacity > 0 ? capacity : 50)
  const server = createSimHttpServer(store)

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set SIM_PORT to a free port.`)
      process.exit(1)
    }
    throw err
  })

  server.listen(port, () => {
    console.log(`Tripwire simulation API listening on http://localhost:${port}`)
    console.log("  GET /health")
    console.log("  GET /simulations/latest?limit=")
    console.log(`  store: in-memory, capacity ${capacity} (recorded by the pipeline, not persisted)`)
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

// Only start a server when executed directly, so importing this module from
// tests or another entrypoint stays side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnv()
}
