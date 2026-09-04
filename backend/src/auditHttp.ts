import { createServer, type Server, type ServerResponse } from "node:http"

import { type AuditFilter, type AuditLedger } from "./auditLedgerSink.js"

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

export function createAuditHttpServer(ledger: AuditLedger): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")

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
