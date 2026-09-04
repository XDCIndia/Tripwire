import "dotenv/config"

import { createGoPlusBlacklistChecker } from "./blacklist.js"
import { createSafeApiClient } from "./safeApiClient.js"
import { scoreTransaction } from "./ruleEngine.js"
import type { PendingTx } from "./types.js"
import { PendingTxWatcher } from "./watcher.js"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const safeAddress = requireEnv("SAFE_ADDRESS")
const chainId = BigInt(requireEnv("CHAIN_ID"))
const txServiceUrl = process.env.TX_SERVICE_URL
const apiKey = process.env.SAFE_TX_SERVICE_API_KEY
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000)

const client = createSafeApiClient({ chainId, txServiceUrl, apiKey })

// #10's counterparty-reputation signal. Never blocks scoring: any GoPlus
// failure or timeout resolves to "unknown", which the rule engine treats as
// a no-op rather than as "safe".
const blacklist = createGoPlusBlacklistChecker({
  chainId,
  apiKey: process.env.GOPLUS_API_KEY,
  timeoutMs: Number(process.env.GOPLUS_TIMEOUT_MS ?? 3000),
})

async function evaluateTx(tx: PendingTx): Promise<void> {
  const counterpartyBlacklist = await blacklist.checkCounterparty(tx.to)
  const result = scoreTransaction({
    data: tx.data,
    value: BigInt(tx.value),
    // TODO(#8 follow-up): wire the watcher's history into these three signals.
    isFirstSeenCounterparty: false,
    isUnverifiedOrFreshContract: false,
    historicalP95Value: 0n,
    counterpartyBlacklist,
  })
  console.log("[watcher] scored pending tx", {
    safeTxHash: tx.safeTxHash,
    to: tx.to,
    counterpartyBlacklist,
    score: result.score,
    label: result.label,
    matchedSignals: result.matchedSignals,
  })
}

// The watcher's callback is synchronous; the async evaluation runs
// fire-and-forget so polling is never held up by the GoPlus round trip.
function onNewTx(tx: PendingTx): void {
  evaluateTx(tx).catch((err: unknown) => console.error("[watcher] evaluation failed:", err))
}

const watcher = new PendingTxWatcher(client, safeAddress, onNewTx)

console.log(`[watcher] watching Safe ${safeAddress} on chain ${chainId} every ${pollIntervalMs}ms`)
watcher.pollOnce().catch((err: unknown) => console.error("[watcher] initial poll failed:", err))
watcher.start(pollIntervalMs)
