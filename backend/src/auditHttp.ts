import { createServer, type Server, type ServerResponse } from "node:http"
import { stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { AuditLedger, createJsonlSink, createMemorySink, type AuditFilter } from "./auditLedgerSink.js"

/**
 * Read-only audit API (issue #52: "expose an API for retrieving
 * transaction audit history" + "support filtering"). Same posture as
 * simHttp: zero dependencies, node:http only, strictly read-only - the
 * investigation surface can fail without ever touching decision-making.
 *
 *   GET /audit/health
 *   GET /audit?safe=&txHash=&verdictId=&riskLevel=&enforcementStatus=&limit=
 *   GET /audit/timeline/:txHash        -> full, un-overwritten event timeline
 */

/** The dashboard is a different origin in dev (Vite :5173), so AuditCard needs these. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS })
  res.end(JSON.stringify(body))
}

/**
 * Only the read surface the API needs. Typed structurally so a reloading
 * delegate (see the entrypoint) can stand in for a live AuditLedger.
 */
export type AuditReadModel = Pick<AuditLedger, "get" | "query" | "timeline">

export function createAuditHttpServer(ledger: AuditReadModel): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (req.method === "GET" && url.pathname === "/audit/health") {
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === "GET" && url.pathname === "/audit") {
      const filter: AuditFilter = {}
      const safe = url.searchParams.get("safe")
      const txHash = url.searchParams.get("txHash")
      const verdictId = url.searchParams.get("verdictId")
      const riskLevel = url.searchParams.get("riskLevel")
      const enforcementStatus = url.searchParams.get("enforcementStatus")
      const limit = Number(url.searchParams.get("limit"))
      if (safe) filter.safe = safe
      if (txHash) filter.txHash = txHash
      if (verdictId) filter.verdictId = verdictId
      if (riskLevel) filter.riskLevel = riskLevel
      if (enforcementStatus) filter.enforcementStatus = enforcementStatus
      if (Number.isFinite(limit) && limit > 0) filter.limit = limit
      sendJson(res, 200, ledger.query(filter))
      return
    }

    const timelineMatch = /^\/audit\/timeline\/(0x[a-fA-F0-9]+)$/.exec(url.pathname)
    if (req.method === "GET" && timelineMatch) {
      const txHash = timelineMatch[1]
      const events = ledger.timeline(txHash)
      if (events.length === 0) {
        sendJson(res, 404, { error: "unknown transaction", txHash })
        return
      }
      sendJson(res, 200, { txHash, record: ledger.get(txHash), timeline: events })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}

// ---------------------------------------------------------------------------
// Entrypoint - `npm run audit`
// ---------------------------------------------------------------------------

async function startFromEnv(): Promise<void> {
  const port = Number(process.env.AUDIT_PORT ?? 3002)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`AUDIT_PORT must be a valid port number, got: ${process.env.AUDIT_PORT}`)
    process.exit(1)
  }

  // Persist by default: an audit trail that resets on restart is not an audit
  // trail. createJsonlSink mkdir -p's its directory and reads a missing file as
  // empty, so this is safe on a fresh clone. AUDIT_LOG_PATH=:memory: opts out.
  const logPath = process.env.AUDIT_LOG_PATH ?? "./.data/audit.jsonl"
  const inMemory = logPath === ":memory:"
  const sink = inMemory ? createMemorySink() : createJsonlSink(logPath)

  const ledger = await AuditLedger.open({
    safe: process.env.SAFE_ADDRESS ?? "0x0000000000000000000000000000000000000000",
    chainId: Number(process.env.CHAIN_ID ?? 51),
    sink,
    onError: (err) => {
      console.error("[audit]", err)
    },
  })

  /**
   * AuditLedger replays its sink once, at open(). The orchestrator is a
   * separate process appending to the same file, so without this the API
   * would serve a snapshot frozen at boot and the dashboard would only ever
   * update on restart. Re-open when the file's mtime moves; a poll that finds
   * nothing new costs one stat().
   */
  let current = ledger
  let lastMtimeMs = 0
  async function fresh(): Promise<AuditReadModel> {
    if (inMemory) return current
    try {
      const { mtimeMs } = await stat(logPath)
      if (mtimeMs !== lastMtimeMs) {
        lastMtimeMs = mtimeMs
        current = await AuditLedger.open({
          safe: process.env.SAFE_ADDRESS ?? "0x0000000000000000000000000000000000000000",
          chainId: Number(process.env.CHAIN_ID ?? 51),
          sink,
        })
      }
    } catch {
      // No file yet, or a torn read - keep serving what we already have.
    }
    return current
  }

  const live: AuditReadModel = {
    get: (txHash) => current.get(txHash),
    query: (filter) => current.query(filter),
    timeline: (txHash) => current.timeline(txHash),
  }

  const server = createAuditHttpServer(live)

  // Poll on a timer rather than per-request: the read path stays synchronous,
  // so firing an un-awaited reload from a request handler would race it and
  // still serve the old snapshot. A 1s tick is well inside the dashboard's own
  // poll interval. unref() so this never holds the process open.
  const reloadTimer = setInterval(() => void fresh(), 1000)
  reloadTimer.unref()
  await fresh()

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set AUDIT_PORT to a free port.`)
      process.exit(1)
    }
    throw err
  })

  server.listen(port, () => {
    console.log(`Tripwire audit API listening on http://localhost:${port}`)
    console.log("  GET /audit/health")
    console.log("  GET /audit?safe=&txHash=&verdictId=&riskLevel=&enforcementStatus=&limit=")
    console.log("  GET /audit/timeline/:txHash")
    console.log(`  sink: ${inMemory ? "in-memory (AUDIT_LOG_PATH=:memory:)" : `jsonl (${logPath})`}`)
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearInterval(reloadTimer)
      server.close(() => process.exit(0))
    })
  }
}

// Only start a server when executed directly, so importing this module from
// tests or another entrypoint stays side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startFromEnv()
}
