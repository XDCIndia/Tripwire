import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { defineChain } from "viem"
import { keccak256, toHex } from "viem"

import { AuditLedger, createJsonlSink, type AuditEventType } from "./auditLedgerSink.js"
import { VerdictRelayer } from "./relayer.js"
import { createRiskRegistryClient } from "./riskRegistryClient.js"
import { compilePolicy } from "./policyCompiler.js"
import { explainPolicy, resolvePolicy } from "./policyMapper.js"
import { validatePolicy } from "./policyValidator.js"
import {
  createMemoryStateStore,
  RiskOrchestrator,
  type ProcessingStatus,
  type ProposedTx,
  type RelayerSlot,
  type TxProcessingState,
} from "./riskOrchestrator.js"

/**
 * Intake + status API for the risk orchestrator (issue #45: "expose
 * transaction status and verdict through an API for the dashboard" and
 * "a backend endpoint for proposed Safe transactions"). Read-only on
 * state plus a single intake endpoint:
 *
 *   POST /tx/propose        { to, value, data, txHash? } -> 202 { txHash, status, duplicate }
 *   POST /policy/compile    { text, usdPerNative?, nativeDecimals? } -> 200 compiled policy
 *   GET  /tx                ?status=&limit= -> newest-first processing states
 *   GET  /tx/:txHash/status -> full processing state incl. canonical verdict
 *   GET  /health
 *
 * When the client omits txHash, a content hash over (to, value, data) is
 * derived so replays of the identical proposal dedupe naturally.
 */

/**
 * The dashboard is served from a different origin in dev (Vite on :5173,
 * this API on :3001), so without these the browser blocks every call from
 * the risk feed and the attack button.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS })
  res.end(JSON.stringify(body, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))
}

function deriveTxHash(to: string, value: string, data: string): string {
  return keccak256(toHex(`${to}|${value}|${data}`))
}

export function createOrchestratorHttpServer(orchestrator: RiskOrchestrator): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost")

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS)
        res.end()
        return
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, pending: orchestrator.pendingCount })
        return
      }

      if (req.method === "POST" && url.pathname === "/tx/propose") {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" })
          return
        }
        const parsed = body as Partial<ProposedTx> & { to?: string; value?: string | number }
        if (!parsed.to || parsed.value === undefined || !parsed.data) {
          sendJson(res, 400, { error: "to, value, and data are required" })
          return
        }
        const tx: ProposedTx = {
          txHash: parsed.txHash ?? deriveTxHash(parsed.to, String(parsed.value), parsed.data),
          to: parsed.to,
          value: BigInt(parsed.value),
          data: parsed.data,
        }
        const result = await orchestrator.propose(tx)
        sendJson(res, 202, result)
        return
      }

      // The single source of truth for turning plain English into Guard
      // config. The dashboard used to run its own parser, which produced a
      // different (and wrong) reading of the same sentence; there is now one
      // grammar, one validator, and one set of failures.
      if (req.method === "POST" && url.pathname === "/policy/compile") {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" })
          return
        }
        const { text, usdPerNative, nativeDecimals } = body as {
          text?: string
          usdPerNative?: string
          nativeDecimals?: number
        }
        if (typeof text !== "string" || text.trim().length === 0) {
          sendJson(res, 400, { error: "text is required" })
          return
        }
        try {
          const policy = compilePolicy(text)
          const issues = validatePolicy(policy)
          if (issues.length > 0) {
            sendJson(res, 400, { error: "policy is invalid", issues })
            return
          }
          const resolved = resolvePolicy(policy, { usdPerNative, nativeDecimals })
          sendJson(res, 200, {
            source: policy.source,
            rules: policy.rules,
            explanation: explainPolicy(policy),
            guardConfig: resolved.guardConfig,
          })
        } catch (err) {
          // Compile and resolve failures are the owner's to see verbatim -
          // the whole point of this grammar is that it never silently drops a
          // clause it could not map.
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      if (req.method === "GET" && url.pathname === "/tx") {
        const status = url.searchParams.get("status") as ProcessingStatus | null
        const limit = Number(url.searchParams.get("limit"))
        sendJson(
          res,
          200,
          await orchestrator.list({
            status: status ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          }),
        )
        return
      }

      const statusMatch = /^\/tx\/(0x[a-fA-F0-9]+)\/status$/.exec(url.pathname)
      if (req.method === "GET" && statusMatch) {
        const state = await orchestrator.status(statusMatch[1])
        if (!state) {
          sendJson(res, 404, { error: "unknown transaction", txHash: statusMatch[1] })
          return
        }
        sendJson(res, 200, state)
        return
      }

      sendJson(res, 404, { error: "not found" })
    })().catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8")
      if (data.length > 1_000_000) reject(new Error("body too large"))
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

// ---------------------------------------------------------------------------
// Entrypoint - `npm run orchestrator`
// ---------------------------------------------------------------------------

interface RelayerConfig {
  rpcUrl: string
  chainId: number
  riskRegistryAddress: `0x${string}`
  relayerPrivateKey: `0x${string}`
  source: string
}

/**
 * Relayer configuration, from the environment first so a real deployment can
 * override, then from local-deployment.json so `demo:reset` needs no setup.
 * Returns undefined when neither is available - the caller degrades to dry-run
 * rather than refusing to start.
 */
function resolveRelayerConfig(): RelayerConfig | undefined {
  const env = {
    rpcUrl: process.env.RPC_URL,
    chainId: process.env.CHAIN_ID,
    riskRegistryAddress: process.env.RISK_REGISTRY_ADDRESS,
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
  }
  if (env.rpcUrl && env.chainId && env.riskRegistryAddress && env.relayerPrivateKey) {
    return {
      rpcUrl: env.rpcUrl,
      chainId: Number(env.chainId),
      riskRegistryAddress: env.riskRegistryAddress as `0x${string}`,
      relayerPrivateKey: env.relayerPrivateKey as `0x${string}`,
      source: "environment",
    }
  }

  try {
    const path = process.env.LOCAL_DEPLOYMENT_PATH ?? "../local-deployment.json"
    const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>
    if (d.rpcUrl && d.chainId && d.riskRegistryAddress && d.relayerPrivateKey) {
      return {
        rpcUrl: d.rpcUrl,
        chainId: Number(d.chainId),
        riskRegistryAddress: d.riskRegistryAddress as `0x${string}`,
        relayerPrivateKey: d.relayerPrivateKey as `0x${string}`,
        source: path,
      }
    }
  } catch {
    // No local deployment - fall through to dry-run.
  }
  return undefined
}

/**
 * The real relayer: writes each verdict to RiskRegistry and waits for the
 * receipt (createRiskRegistryClient throws on anything but a successful mine),
 * so "submitted" in the pipeline means the Guard can actually read it.
 *
 * The orchestrator hands over the *canonical* score and label — rule engine
 * plus simulation plus any reasoning pass — so submitFinal converts exactly
 * the decision the dashboard displays, not just the rule-engine floor.
 */
function createOnChainRelayer(config: RelayerConfig): RelayerSlot {
  const chain = defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  })

  const relayer = new VerdictRelayer(
    createRiskRegistryClient({
      chain,
      rpcUrl: config.rpcUrl,
      contractAddress: config.riskRegistryAddress,
      relayerPrivateKey: config.relayerPrivateKey,
    }),
  )

  return {
    async submit(txHash, verdict) {
      // Errors propagate: the orchestrator records them on the tx state as
      // `submission_failed` with the message, which the audit trail picks up.
      await relayer.submitFinal(txHash as `0x${string}`, verdict, undefined)
    },
  }
}

/** Used only when no registry is configured. Logs and writes nothing. */
function createLoggingRelayer(): RelayerSlot {
  return {
    async submit(txHash, verdict) {
      console.log(`[relayer:dry-run] ${txHash} score=${verdict.score} label=${verdict.label}`)
    },
  }
}

/**
 * Maps a pipeline state transition onto an audit event type. The ledger models
 * the decision lifecycle, not the queue's internal states, so the two
 * intermediate statuses collapse into the phase they belong to.
 */
const AUDIT_EVENT_FOR_STATUS: Record<ProcessingStatus, AuditEventType | undefined> = {
  received: "detected",
  analyzing: "analysis",
  verdict_ready: "verdict",
  // A queue internal, not a decision-lifecycle phase - recording it would put a
  // second, meaningless "analysis" between the verdict and its enforcement.
  submitting: undefined,
  submitted: "enforcement",
  submission_failed: "failure",
}

/** Flattens the canonical verdict into the shape `AuditLedger.get` folds into a record. */
function auditDataFor(state: TxProcessingState, note?: string): Record<string, unknown> {
  const data: Record<string, unknown> = { status: state.status }
  if (note) data.note = note
  const c = state.canonical
  if (c) {
    data.score = c.score
    data.status = c.status
    data.action = c.action
    data.explanation = c.explanation
  }
  return data
}

async function startFromEnv(): Promise<void> {
  const port = Number(process.env.ORCHESTRATOR_PORT ?? 3001)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`ORCHESTRATOR_PORT must be a valid port number, got: ${process.env.ORCHESTRATOR_PORT}`)
    process.exit(1)
  }

  // The same jsonl file the audit API reads, so the audit trail reflects this
  // pipeline's decisions instead of being permanently empty. Default matches
  // auditHttp's own AUDIT_LOG_PATH default.
  const auditPath = process.env.AUDIT_LOG_PATH ?? "./.data/audit.jsonl"
  const auditLedger =
    auditPath === ":memory:"
      ? undefined
      : await AuditLedger.open({
          safe: process.env.SAFE_ADDRESS ?? "0x0000000000000000000000000000000000000000",
          chainId: Number(process.env.CHAIN_ID ?? 51),
          sink: createJsonlSink(auditPath),
          onError: (err) => {
            console.error("[orchestrator:audit]", err)
          },
        })

  const relayerConfig = resolveRelayerConfig()
  const relayer = relayerConfig ? createOnChainRelayer(relayerConfig) : createLoggingRelayer()

  const orchestrator = RiskOrchestrator.create({
    relayer,
    store: createMemoryStateStore(),
    audit: auditLedger
      ? (state, note) => {
          const type = AUDIT_EVENT_FOR_STATUS[state.status]
          if (type) auditLedger.log(state.txHash, type, "rule-engine", auditDataFor(state, note))
        }
      : undefined,
    onError: (err) => {
      console.error("[orchestrator]", err)
    },
  })

  const server = createOrchestratorHttpServer(orchestrator)

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set ORCHESTRATOR_PORT to a free port.`)
      process.exit(1)
    }
    throw err
  })

  server.listen(port, () => {
    console.log(`Tripwire orchestrator listening on http://localhost:${port}`)
    console.log("  GET  /health")
    console.log("  GET  /tx?status=&limit=")
    console.log("  GET  /tx/:txHash/status")
    console.log("  POST /tx/propose   { to, value, data }")
    console.log("  POST /policy/compile { text, usdPerNative? }")
    if (relayerConfig) {
      console.log(`  relayer: on-chain -> RiskRegistry ${relayerConfig.riskRegistryAddress}`)
      console.log(`           chain ${relayerConfig.chainId} via ${relayerConfig.rpcUrl} (config: ${relayerConfig.source})`)
    } else {
      console.log("  relayer: DRY-RUN - no registry configured, verdicts are NOT written on-chain")
      console.log("           set RPC_URL / CHAIN_ID / RISK_REGISTRY_ADDRESS / RELAYER_PRIVATE_KEY,")
      console.log("           or run scripts/localDeploy.ts to produce local-deployment.json")
    }
    console.log(`  audit:   ${auditLedger ? `jsonl (${auditPath})` : "disabled (AUDIT_LOG_PATH=:memory:)"}`)
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

// Only start a server when this module is executed directly, so importing it
// from tests or from another entrypoint stays side-effect free. pathToFileURL
// handles Windows drive letters and separators, which a hand-built file:// URL
// does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startFromEnv()
}
