/**
 * Wires the REAL, tested pipeline - OnchainAttemptWatcher + rule engine +
 * relayer - against the locally-deployed stack from
 * scripts/localDeploy.ts, for full end-to-end manual testing. Not a
 * reimplementation for the demo: the exact same modules #9/#13/#38 ship.
 *
 *   npx tsx scripts/localWatcherLoop.ts
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createPublicClient, createWalletClient, http, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { OnchainAttemptWatcher, type OnchainClient } from "../src/onchainAttemptWatcher.js"
import { scoreTransaction } from "../src/ruleEngine.js"
import { VerdictRelayer } from "../src/relayer.js"
import { createSafeExecDecoder } from "../src/safeExecDecoder.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "local-deployment.json"), "utf8"))

const RISK_REGISTRY_ABI = parseAbi([
  "function submitVerdict(bytes32 txHash, (uint8 status, uint8 score, uint256 releaseAt) verdict) external",
  "function defaultDelayWindow() view returns (uint256)",
])

async function main() {
  console.log("Watching Safe", deployment.safeAddress, "on", deployment.rpcUrl)

  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) })
  const relayerAccount = privateKeyToAccount(deployment.relayerPrivateKey)
  const walletClient = createWalletClient({ account: relayerAccount, transport: http(deployment.rpcUrl) })

  const onchainClient: OnchainClient = {
    async getLatestBlockNumber() {
      return publicClient.getBlockNumber()
    },
    async getBlockTransactions(blockNumber) {
      const block = await publicClient.getBlock({ blockNumber, includeTransactions: true })
      return block.transactions.map((tx) => ({
        from: tx.from,
        to: tx.to,
        input: tx.input,
        nonce: tx.nonce,
      }))
    },
  }

  const relayer = new VerdictRelayer({
    async submitVerdict(txHash, verdict) {
      const hash = await walletClient.writeContract({
        address: deployment.riskRegistryAddress,
        abi: RISK_REGISTRY_ABI,
        functionName: "submitVerdict",
        args: [txHash, { status: verdict.status, score: verdict.score, releaseAt: BigInt(verdict.releaseAt) }],
        chain: null,
      })
      await publicClient.waitForTransactionReceipt({ hash })
    },
    async delayWindow() {
      const seconds = await publicClient.readContract({
        address: deployment.riskRegistryAddress,
        abi: RISK_REGISTRY_ABI,
        functionName: "defaultDelayWindow",
      })
      return Number(seconds)
    },
  })

  const decoder = createSafeExecDecoder()

  const watcher = new OnchainAttemptWatcher(onchainClient, decoder, deployment.safeAddress, (tx) => {
    console.log("\n[watcher] new attempt:", { to: tx.to, value: tx.value, safeTxHash: tx.safeTxHash })

    // A plain ETH transfer (no calldata) is treated as familiar/verified;
    // anything calling into a contract (e.g. the drainer's
    // setApprovalForAll) is treated as first-seen/unverified. Real
    // context (#8/#9's actual inputs) comes from an indexer/block
    // explorer lookup - this local harness approximates it just well
    // enough to demonstrate "benign passes, attack gets caught."
    const isContractCall = tx.data !== "0x"
    const result = scoreTransaction({
      data: tx.data,
      value: BigInt(tx.value),
      isFirstSeenCounterparty: isContractCall,
      isUnverifiedOrFreshContract: isContractCall,
      historicalP95Value: 0n,
    })
    console.log("[rule engine]", result)

    relayer
      .submitFast(tx.safeTxHash as `0x${string}`, result)
      .then((verdict) => console.log("[relayer] submitted verdict:", verdict))
      .catch((err) => console.error("[relayer] failed to submit verdict:", err))
  })

  console.log("Polling every 2s. Trigger an attempt in another terminal, then watch it get scored here.\n")
  await watcher.pollOnce()
  setInterval(() => {
    watcher.pollOnce().catch((err) => console.error("[watcher] poll failed:", err))
  }, 2000)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
