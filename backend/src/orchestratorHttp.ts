/**
 * Issue #102: Orchestrator HTTP server
 *
 * Minimal HTTP server that exposes the routes the frontend dashboard
 * expects:
 *   GET  /health       → { ok: true }
 *   GET  /tx           → risk feed (array of tx verdicts, newest first)
 *   POST /tx/propose   → accept a new transaction for risk evaluation
 *
 * Sits in front of the existing watcher + rule-engine pipeline so the
 * frontend can poll for verdicts and trigger the attack simulation.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// ─── In-memory verdict store ─────────────────────────────────────────

export interface TxVerdict {
  txHash: string
  status: "low_risk" | "medium_risk" | "high_risk" | "frozen" | "pending"
  score?: number
  action?: "allow" | "delay" | "block" | "freeze"
  reasons?: string[]
  at: string
}

const verdicts: TxVerdict[] = []
const MAX_VERDICTS = 200

export function addVerdict(verdict: TxVerdict): void {
  verdicts.unshift(verdict)
  if (verdicts.length > MAX_VERDICTS) verdicts.length = MAX_VERDICTS
}

export function getVerdicts(): TxVerdict[] {
  return verdicts
}

// ─── HTTP helpers ────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

// ─── Request handler ─────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req

  // CORS headers for frontend dev server
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "content-type")

  if (method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // GET /health
  if (method === "GET" && url === "/health") {
    json(res, 200, { ok: true, verdicts: verdicts.length })
    return
  }

  // GET /tx — risk feed
  if (method === "GET" && url === "/tx") {
    json(res, 200, verdicts)
    return
  }

  // POST /tx/propose — accept a new transaction
  if (method === "POST" && url === "/tx/propose") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        txHash?: string
        to?: string
        data?: string
        value?: string
      }

      const txHash = body.txHash ?? `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`

      // Add as pending verdict — the watcher pipeline will score it
      addVerdict({
        txHash,
        status: "pending",
        at: new Date().toISOString(),
      })

      json(res, 201, { ok: true, txHash, message: "Transaction submitted for risk evaluation" })
    } catch {
      json(res, 400, { ok: false, error: "Invalid JSON body" })
    }
    return
  }

  // 404
  json(res, 404, { ok: false, error: "Not found" })
}

// ─── Server startup ──────────────────────────────────────────────────

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 3001)

const server = createServer((req, res) => {
  void handleRequest(req, res)
})

server.listen(PORT, () => {
  console.log(`[orchestrator] listening on http://localhost:${PORT}`)
  console.log(`[orchestrator] routes: GET /health, GET /tx, POST /tx/propose`)
})
