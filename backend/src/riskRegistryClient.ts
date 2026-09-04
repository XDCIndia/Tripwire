import { type Chain, createPublicClient, createWalletClient, http, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { VerdictRevertedError, type RiskRegistryClient } from "./relayer.js"
import type { OnChainVerdict } from "./verdict.js"

const RISK_REGISTRY_ABI = parseAbi([
  "function submitVerdict(bytes32 txHash, (uint8 status, uint8 score, uint256 releaseAt) verdict) external",
])

/** Hard ceiling on any single RPC round trip - a hung endpoint must fail, not stall the pipeline. */
const RPC_TIMEOUT_MS = 10_000

export interface RiskRegistryClientConfig {
  /** The chain the RiskRegistry contract is deployed on, e.g. from `viem/chains` (sepolia), or a custom XDC Apothem definition. */
  chain: Chain
  rpcUrl: string
  contractAddress: `0x${string}`
  /** The relayer's private key. Read from an env var by the caller - never hardcode or commit this. */
  relayerPrivateKey: `0x${string}`
}

/**
 * Real on-chain implementation of `RiskRegistryClient`, backed by viem.
 * Deliberately thin and kept behind the same interface `relayer.ts` is
 * unit-tested against, for the same reason `safeApiClient.ts` wraps
 * `@safe-global/api-kit`: the relayer's actual verdict-combining logic is
 * fully tested with a mock; this file is the untestable-without-a-live-chain
 * remainder, kept as small as possible.
 *
 * `writeContract` only returns a hash - it never confirms the transaction
 * landed. A relayer whose whole point is "a seen transaction is never left
 * UNSCORED" must not report success on a reverted or dropped submission, so
 * every call waits for its receipt and throws on anything but success.
 * Waiting per call also serializes nonce assignment across submissions from
 * the same key, which concurrent fire-and-forget writes would race on.
 */
export function createRiskRegistryClient(config: RiskRegistryClientConfig): RiskRegistryClient {
  const account = privateKeyToAccount(config.relayerPrivateKey)
  const transport = http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS })
  const walletClient = createWalletClient({ account, chain: config.chain, transport })
  const publicClient = createPublicClient({ chain: config.chain, transport })

  return {
    async submitVerdict(txHash: `0x${string}`, verdict: OnChainVerdict): Promise<void> {
      const hash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: RISK_REGISTRY_ABI,
        functionName: "submitVerdict",
        args: [txHash, { status: verdict.status, score: verdict.score, releaseAt: BigInt(verdict.releaseAt) }],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") {
        // Typed so the relayer can tell "deterministic revert, don't retry"
        // apart from "transient RPC failure, retry" - see relayer.ts.
        throw new VerdictRevertedError(txHash, hash)
      }
    },
  }
}
