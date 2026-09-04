import { describe, expect, it, vi } from "vitest"

import { createGoPlusBlacklistChecker } from "../src/blacklist.js"
import { VerdictRelayer } from "../src/relayer.js"
import { scoreTransaction } from "../src/ruleEngine.js"
import type { OnChainVerdict } from "../src/verdict.js"
import type { PendingTx, RawPendingTx, SafeTxServiceClient } from "../src/types.js"
import { PendingTxWatcher } from "../src/watcher.js"

const SAFE = "0xSafe0000000000000000000000000000000000"
const TARGET = "0xAbcdefabcdefabcdefabcdefabcdefabcdefabcd"

const pad32 = (hex: string): string => hex.padStart(64, "0")
const MAX_UINT256_WORD = "f".repeat(64)
const UNLIMITED_APPROVE_DATA = `0x095ea7b3${pad32("abcdefabcdefabcdefabcdefabcdefabcdefabcd")}${MAX_UINT256_WORD}`

function rawTx(overrides: Partial<RawPendingTx> = {}): RawPendingTx {
  return {
    safeTxHash: "0xhash1",
    to: TARGET,
    value: "0",
    data: UNLIMITED_APPROVE_DATA,
    nonce: "1",
    proposer: "0xProposer0000000000000000000000000000000",
    ...overrides,
  }
}

function clientWith(raw: RawPendingTx): SafeTxServiceClient {
  return { getPendingTransactions: vi.fn(async () => ({ results: [raw] })) }
}

/**
 * Mirrors the wiring in index.ts: watcher -> GoPlus blacklist lookup ->
 * rule engine -> relayer. The point of this test is the contract #15's
 * acceptance criterion depends on: when the external lookup is down, the
 * pipeline must still score and submit a verdict for every transaction -
 * "unknown" must flow through, never block, and never be read as "clean".
 */
async function runPipeline(
  blacklist: ReturnType<typeof createGoPlusBlacklistChecker>,
  raw: RawPendingTx,
): Promise<{ tx: PendingTx; blacklist: string; verdict: OnChainVerdict }> {
  const watcher = new PendingTxWatcher(clientWith(raw), SAFE, () => {})
  const [tx] = await watcher.pollOnce()

  const counterpartyBlacklist = await blacklist.checkCounterparty(tx.to)
  const result = scoreTransaction({
    data: tx.data,
    value: BigInt(tx.value),
    isFirstSeenCounterparty: false,
    isUnverifiedOrFreshContract: false,
    historicalP95Value: 0n,
    counterpartyBlacklist,
  })

  let submitted: OnChainVerdict | undefined
  const relayer = new VerdictRelayer({
    async submitVerdict(_txHash, verdict) {
      submitted = verdict
    },
  })
  await relayer.submitFast(tx.safeTxHash as `0x${string}`, result)
  if (!submitted) throw new Error("relayer did not submit")
  return { tx, blacklist: counterpartyBlacklist, verdict: submitted }
}

describe("pipeline fallback (issue #15 acceptance criterion 2)", function () {
  it("scores and submits a verdict for every tx when GoPlus is fully down", async function () {
    const failingFetch = vi.fn(async () => {
      throw new Error("connection refused")
    })
    const blacklist = createGoPlusBlacklistChecker({
      chainId: 31337,
      fetchImpl: failingFetch as unknown as typeof fetch,
      timeoutMs: 100,
    })

    const outcome = await runPipeline(blacklist, rawTx())

    // The fallback was exercised, not skipped, and collapsed to "unknown".
    expect(failingFetch).toHaveBeenCalled()
    expect(outcome.blacklist).toBe("unknown")
    // Scoring still ran on calldata alone: the unlimited approve scores 40.
    expect(outcome.verdict.score).toBe(40)
    expect(outcome.verdict.status).toBe(2) // DELAYED
  })

  it("scores and submits when GoPlus hangs past the timeout", async function () {
    const hangingFetch = ((url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")))
      })) as unknown as typeof fetch

    const blacklist = createGoPlusBlacklistChecker({ chainId: 31337, fetchImpl: hangingFetch, timeoutMs: 50 })

    const start = Date.now()
    const outcome = await runPipeline(blacklist, rawTx({ safeTxHash: "0xhash2" }))

    expect(outcome.blacklist).toBe("unknown")
    expect(outcome.verdict.score).toBe(40)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
