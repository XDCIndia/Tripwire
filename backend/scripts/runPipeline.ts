/**
 * End-to-end pipeline rehearsal for issue #15's acceptance criterion:
 * "Full pipeline run 3x in a row against local Anvil with no manual
 * intervention."
 *
 * One command exercises every real backend module in sequence, per pass:
 *
 *   mock Safe service (scripted pending txs)
 *     -> PendingTxWatcher            (Sense: dedupe + normalize)
 *     -> GoPlus blacklist checker    (counterparty reputation, live API w/ fallback)
 *     -> scoreTransaction            (Reason: deterministic scoring)
 *     -> simulateTransaction         (verify calldata against real chain state)
 *     -> VerdictRelayer.submitFast   (Act: verdict on-chain)
 *     -> RiskRegistry.verdictOf      (read back + assert exact match)
 *
 * The runner deploys its own RiskRegistry to a fresh anvil, so the only
 * prerequisite is a running anvil instance. The GoPlus lookup runs against
 * the live API: anvil's chain id (31337) is not one GoPlus supports, so the
 * expected result is "unknown" - which is exactly the failure fallback this
 * rehearsal is meant to prove non-blocking in situ.
 *
 * Usage:
 *   anvil --port 8545 &
 *   RPC_URL=http://127.0.0.1:8545 npx tsx scripts/runPipeline.ts
 *
 * Env:
 *   RPC_URL        - anvil JSON-RPC endpoint (default http://127.0.0.1:8545)
 *   RUNS           - number of consecutive full passes (default 3)
 *   GOPLUS_API_KEY - optional, raises the live-lookup rate limit
 */
import { readFileSync } from "node:fs"

import { type Chain, createPublicClient, createWalletClient, http, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"

import { createAnvilForkClient } from "../src/anvilForkClient.js"
import { createGoPlusBlacklistChecker } from "../src/blacklist.js"
import { VerdictRelayer } from "../src/relayer.js"
import { createRiskRegistryClient } from "../src/riskRegistryClient.js"
import { scoreTransaction } from "../src/ruleEngine.js"
import { simulateTransaction } from "../src/simulate.js"
import type { PendingTx, RawPendingTx, SafeTxServiceClient } from "../src/types.js"
import { PendingTxWatcher } from "../src/watcher.js"

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545"
const RUNS = Number(process.env.RUNS ?? 3)

// Anvil's well-known default accounts (same on every fresh instance).
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const
const OWNER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const SPENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const

const VERDICT_OF_ABI = parseAbi([
  "function verdictOf(bytes32 txHash) view returns (uint8 status, uint8 score, uint256 releaseAt)",
])

const pad32 = (hex: string): string => hex.padStart(64, "0")
const ADDRESS_HEX = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
const MAX_UINT256_WORD = "f".repeat(64)

interface Scenario {
  name: string
  to: string
  value: string
  data: string
}

// One low-risk shape and two drainer primitives - enough variety to see all
// three risk labels across a pass without depending on live GoPlus data.
const SCENARIOS: Scenario[] = [
  { name: "plain transfer", to: SPENDER, value: "1000000000000000", data: "0x" },
  { name: "unlimited approve", to: SPENDER, value: "0", data: `0x095ea7b3${pad32(ADDRESS_HEX)}${MAX_UINT256_WORD}` },
  { name: "setApprovalForAll", to: SPENDER, value: "0", data: `0xa22cb465${pad32(ADDRESS_HEX)}${pad32("1")}` },
]

function scenarioToRawTx(pass: number, index: number, scenario: Scenario): RawPendingTx {
  // Deterministic unique bytes32 per (pass, scenario): anvil state persists
  // across passes, and reusing a safeTxHash would read back a stale verdict.
  const tag = `${pass.toString(16).padStart(2, "0")}${index.toString(16).padStart(2, "0")}`
  return {
    safeTxHash: `0x${tag}${"0".repeat(60)}`,
    to: scenario.to,
    value: scenario.value,
    data: scenario.data,
    nonce: String(pass * 10 + index),
    proposer: OWNER,
  }
}

function scriptedClient(pass: number): SafeTxServiceClient {
  return {
    async getPendingTransactions(_safeAddress: string) {
      return { results: SCENARIOS.map((scenario, index) => scenarioToRawTx(pass, index, scenario)) }
    },
  }
}

async function deployRiskRegistry(): Promise<`0x${string}`> {
  const artifact = JSON.parse(
    readFileSync(new URL("../../artifacts/contracts/RiskRegistry.sol/RiskRegistry.json", import.meta.url), "utf8"),
  ) as { abi: unknown; bytecode: string }

  const account = privateKeyToAccount(OWNER_PRIVATE_KEY)
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(RPC_URL) })
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: [OWNER, OWNER],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error("RiskRegistry deployment produced no contract address")
  return receipt.contractAddress
}

interface PassResult {
  scenario: string
  safeTxHash: string
  blacklist: string
  score: number
  label: string
  simulatedBalanceDelta: string
  onChainStatus: number
}

interface PassSummary {
  registryAddress: string
  results: PassResult[]
}

async function runPass(pass: number): Promise<PassSummary> {
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })
  const registryAddress = await deployRiskRegistry()

  const blacklist = createGoPlusBlacklistChecker({
    chainId: foundry.id,
    apiKey: process.env.GOPLUS_API_KEY,
    timeoutMs: 3000,
  })
  const forkClient = createAnvilForkClient({ rpcUrl: RPC_URL })
  const relayer = new VerdictRelayer(
    createRiskRegistryClient({
      chain: foundry as Chain,
      rpcUrl: RPC_URL,
      contractAddress: registryAddress,
      relayerPrivateKey: OWNER_PRIVATE_KEY,
    }),
  )

  async function evaluate(tx: PendingTx, scenario: string): Promise<PassResult> {
    // Live GoPlus call. On anvil's unsupported chain id this resolves to
    // "unknown" via the fallback path - by design, see module doc comment.
    const counterpartyBlacklist = await blacklist.checkCounterparty(tx.to)

    const ruleResult = scoreTransaction({
      data: tx.data,
      value: BigInt(tx.value),
      isFirstSeenCounterparty: false,
      isUnverifiedOrFreshContract: false,
      historicalP95Value: 0n,
      counterpartyBlacklist,
    })

    const simDiff = await simulateTransaction(forkClient, {
      from: OWNER,
      to: tx.to as `0x${string}`,
      value: BigInt(tx.value),
      data: tx.data as `0x${string}`,
    })

    const verdict = await relayer.submitFast(tx.safeTxHash as `0x${string}`, ruleResult)

    // Read the verdict back from the registry and demand an exact match -
    // a verdict that didn't land on-chain doesn't count as written.
    const onChain = await publicClient.readContract({
      address: registryAddress,
      abi: VERDICT_OF_ABI,
      functionName: "verdictOf",
      args: [tx.safeTxHash as `0x${string}`],
    })
    // viem decodes the returned struct as a positional tuple
    // [status, score, releaseAt] even though the ABI names the fields.
    const [onChainStatus, onChainScore] = onChain
    if (onChainStatus !== verdict.status || onChainScore !== verdict.score) {
      throw new Error(
        `on-chain verdict mismatch for ${tx.safeTxHash}: ` +
          `submitted status=${verdict.status} score=${verdict.score}, ` +
          `read back status=${onChainStatus} score=${onChainScore}`,
      )
    }

    return {
      scenario,
      safeTxHash: tx.safeTxHash,
      blacklist: counterpartyBlacklist,
      score: ruleResult.score,
      label: ruleResult.label,
      simulatedBalanceDelta: (simDiff.balanceBefore - simDiff.balanceAfter).toString(),
      onChainStatus,
    }
  }

  const byHash = new Map(
    SCENARIOS.map((scenario, index) => [scenarioToRawTx(pass, index, scenario).safeTxHash, scenario.name]),
  )
  const watcher = new PendingTxWatcher(scriptedClient(pass), OWNER, () => {})

  const fresh = await watcher.pollOnce()

  // Sequential, in watcher order: each verdict submission mines before the
  // next starts, so nonce assignment stays deterministic - and the receipt
  // wait in the client makes every submission confirmed before readback.
  const results: PassResult[] = []
  for (const tx of fresh) {
    results.push(await evaluate(tx, byHash.get(tx.safeTxHash) ?? "unknown scenario"))
  }
  return { registryAddress, results }
}

async function main(): Promise<void> {
  for (let pass = 1; pass <= RUNS; pass++) {
    const { registryAddress, results } = await runPass(pass)
    console.log(`\n[pass ${pass}/${RUNS}] registry=${registryAddress}`)
    for (const result of results) {
      console.log(
        `  ${result.scenario.padEnd(18)} blacklist=${result.blacklist.padEnd(8)} ` +
          `score=${String(result.score).padStart(3)} ${result.label.padEnd(12)} ` +
          `simDelta=${result.simulatedBalanceDelta} wei onChainStatus=${result.onChainStatus} ✓`,
      )
    }
  }
  console.log(
    `\nOK: full pipeline (watcher → blacklist → rule engine → simulation → relayer → on-chain readback) ran ${RUNS}x consecutively.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
