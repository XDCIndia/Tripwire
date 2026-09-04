/**
 * Real on-chain reader for the reconciliation service (issue #50).
 *
 * Implements `ReconcileChainReader` against a live chain with viem: reads
 * the RiskRegistry verdict for a Safe transaction hash, the TripwireGuard's
 * controls (freeze switch + spending limits), and the execution outcome of
 * the enforcement attempt itself. Every read is a single `eth_call`/receipt
 * lookup - this layer never writes, so it can never make a bad situation
 * worse, and a failed read fails the check rather than guessing.
 *
 * Contract functions used (keep in sync with contracts/):
 *   RiskRegistry.verdictOf(bytes32) returns (Verdict) - contracts/interfaces/IRiskRegistry.sol
 *   TripwireGuard.frozen(), .perTxLimit(), .rollingLimit(), .windowSpent() - contracts/TripwireGuard.sol
 */
import { type Chain, createPublicClient, http, parseAbi } from "viem"

import type { ReconcileChainReader } from "./reconcileService.js"
import {
  type ExecutionObservation,
  type GuardChainState,
  type RegistryVerdictState,
} from "./reconcileTypes.js"
import type { RiskStatusValue } from "./verdict.js"

const RISK_REGISTRY_ABI = parseAbi([
  "function verdictOf(bytes32 txHash) view returns ((uint8 status, uint8 score, uint256 releaseAt))",
])

const GUARD_ABI = parseAbi([
  "function frozen() view returns (bool)",
  "function perTxLimit() view returns (uint256)",
  "function rollingLimit() view returns (uint256)",
  "function windowSpent() view returns (uint256)",
])

export interface ReconcileChainConfig {
  /** The chain the contracts are deployed on, e.g. from `viem/chains`. */
  chain: Chain
  rpcUrl: string
  riskRegistryAddress: `0x${string}`
  guardAddress: `0x${string}`
}

/** Reads execution state for an enforcement attempt by its tx hash. */
async function observeExecution(
  publicClient: ReturnType<typeof createPublicClient>,
  enforcementTxHash: `0x${string}` | null,
): Promise<ExecutionObservation> {
  if (enforcementTxHash === null) return { kind: "none" }
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: enforcementTxHash })
    // Receipt-level status: a Safe execution that the Guard reverted still
    // lands as a reverted receipt, so a BLOCK that "executed" is visible
    // here as either a success (Guard bypassed - MISMATCH) or a revert.
    return receipt.status === "success" ? { kind: "success" } : { kind: "reverted" }
  } catch {
    // No receipt yet: either still in the mempool (pending) or gone.
    try {
      await publicClient.getTransaction({ hash: enforcementTxHash })
      return { kind: "pending" }
    } catch {
      return { kind: "dropped", replacedBy: null }
    }
  }
}

export function createReconcileChainReader(config: ReconcileChainConfig): ReconcileChainReader {
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })

  return {
    async readState(safeTxHash, enforcementTxHash) {
      const [rawVerdict, frozen, perTxLimit, rollingLimit, windowSpent] = await Promise.all([
        publicClient.readContract({
          address: config.riskRegistryAddress,
          abi: RISK_REGISTRY_ABI,
          functionName: "verdictOf",
          args: [safeTxHash as `0x${string}`],
        }),
        publicClient.readContract({
          address: config.guardAddress,
          abi: GUARD_ABI,
          functionName: "frozen",
        }),
        publicClient.readContract({
          address: config.guardAddress,
          abi: GUARD_ABI,
          functionName: "perTxLimit",
        }),
        publicClient.readContract({
          address: config.guardAddress,
          abi: GUARD_ABI,
          functionName: "rollingLimit",
        }),
        publicClient.readContract({
          address: config.guardAddress,
          abi: GUARD_ABI,
          functionName: "windowSpent",
        }),
      ])

      // An unset verdict reads back as Status.UNSCORED (0) by construction
      // of the registry - there is no "absent" vs "scored UNSCORED" split
      // to be wrong about.
      const verdict = rawVerdict as unknown as { status: number; score: number; releaseAt: bigint }
      const registryVerdict: RegistryVerdictState = {
        // RiskStatusValue is 0-4, exactly what the registry enum encodes.
        status: Number(verdict.status) as RiskStatusValue,
        score: Number(verdict.score),
        releaseAt: Number(verdict.releaseAt),
      }
      const guard: GuardChainState = {
        frozen,
        perTxLimit,
        rollingLimit,
        windowSpent,
      }
      const execution = await observeExecution(publicClient, enforcementTxHash as `0x${string}` | null)
      return { registryVerdict, guard, execution }
    },
  }
}
