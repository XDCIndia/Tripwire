/**
 * Internal reconciliation API (issue #50: "status reporting/API").
 *
 * Exposes the attestation log and check loop over HTTP for operators and
 * dashboards: list enforcement records, read one record's latest result and
 * immutable check history, trigger an immediate on-chain check, and run a
 * due-cycle of automatic re-checks (returning any critical alerts raised).
 *
 * Same shape as the rest of the backend: pure handlers that take the
 * service + parsed input and return plain JSON-able values, so every
 * endpoint is unit-testable without a socket, plus a thin `node:http`
 * server that binds them. The server never writes state on GETs, and every
 * handler returns `{ ok: false, error }` instead of throwing across HTTP.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { ReconciliationService } from "./reconcileService.js"
import type { ReconciliationStatus } from "./reconcileTypes.js"

export type ReconcileHttpResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

export interface ReconcileApi {
  health(): ReconcileHttpResponse
  listRecords(query: { status?: string }): ReconcileHttpResponse
  getRecord(txHash: string): ReconcileHttpResponse
  getHistory(txHash: string): ReconcileHttpResponse
  check(txHash: string): Promise<ReconcileHttpResponse>
  runDueCycle(): Promise<ReconcileHttpResponse>
}

const STATUSES: ReconciliationStatus[] = ["MATCH", "MISMATCH", "PENDING", "REVERTED", "DROPPED"]

export function createReconcileApi(service: ReconciliationService): ReconcileApi {
  return {
    health() {
      return { ok: true, data: { status: "ok", records: service.log.size(), now: Date.now() } }
    },

    listRecords(query) {
      const status = query.status
      if (status !== undefined && !(STATUSES as string[]).includes(status)) {
        return { ok: false, error: `unknown status filter '${status}' (expected one of ${STATUSES.join(", ")})` }
      }
      return { ok: true, data: service.records(status === undefined ? {} : { status: status as ReconciliationStatus }) }
    },

    getRecord(txHash) {
      const record = service.getRecord(txHash)
      if (!record) return { ok: false, error: `no enforcement record for ${txHash}` }
      return { ok: true, data: record }
    },

    getHistory(txHash) {
      if (!service.getRecord(txHash)) return { ok: false, error: `no enforcement record for ${txHash}` }
      return { ok: true, data: service.historyOf(txHash) }
    },

    async check(txHash) {
      try {
        const outcome = await service.check(txHash)
        return { ok: true, data: outcome }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async runDueCycle() {
      const { checked, alerts } = await service.runDueCycle()
      return { ok: true, data: { checked: checked.map((outcome) => outcome.record), alerts } }
    },
  }
}

export interface ReconcileServerConfig {
  service: ReconciliationService
  /** Default 8787. */
  port?: number
  /** Bind host, default 127.0.0.1 - internal endpoint, not for the WAN. */
  host?: string
}

export function startReconcileServer(config: ReconcileServerConfig): Server {
  const api = createReconcileApi(config.service)
  const port = config.port ?? 8787
  const host = config.host ?? "127.0.0.1"

  const server = createServer((req, res) => {
    void handleRequest(req, res, api)
  })
  server.listen(port, host)
  return server
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, api: ReconcileApi): Promise<void> {
  const url = req.url ?? "/"
  const path = url.split("?")[0]
  const method = req.method ?? "GET"

  const json = (statusCode: number, body: ReconcileHttpResponse): void => {
    res.writeHead(statusCode, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  // GET /reconcile/health
  if (method === "GET" && path === "/reconcile/health") {
    return json(200, api.health())
  }

  // GET /reconcile/records?status=PENDING
  if (method === "GET" && path === "/reconcile/records") {
    const status = new URL(url, "http://localhost").searchParams.get("status") ?? undefined
    const body = api.listRecords({ status })
    return json(body.ok ? 200 : 400, body)
  }

  // GET /reconcile/records/:txHash/events
  const eventsMatch = /^\/reconcile\/records\/([^/]+)\/events$/.exec(path)
  if (method === "GET" && eventsMatch) {
    const body = api.getHistory(decodeURIComponent(eventsMatch[1]))
    return json(body.ok ? 200 : 404, body)
  }

  // GET /reconcile/records/:txHash
  const recordMatch = /^\/reconcile\/records\/([^/]+)$/.exec(path)
  if (method === "GET" && recordMatch) {
    const body = api.getRecord(decodeURIComponent(recordMatch[1]))
    return json(body.ok ? 200 : 404, body)
  }

  // POST /reconcile/check  { "txHash": "0x..." }
  if (method === "POST" && path === "/reconcile/check") {
    const parsed = await readJsonBody(req)
    if (typeof parsed?.txHash !== "string") return json(400, { ok: false, error: "body must be { txHash: string }" })
    const body = await api.check(parsed.txHash)
    return json(body.ok ? 200 : 404, body)
  }

  // POST /reconcile/cycle
  if (method === "POST" && path === "/reconcile/cycle") {
    const body = await api.runDueCycle()
    return json(body.ok ? 200 : 500, body)
  }

  return json(404, { ok: false, error: `no route: ${method} ${path}` })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  await new Promise<void>((resolve) => req.on("end", () => resolve()))
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
