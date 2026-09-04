/**
 * Worker implementations for each analysis type.
 *
 * These wrap the existing deterministic rule engine, simulation, and
 * (future) LLM modules behind the WorkerFn interface so they can be
 * registered with the JobRunner. Each worker is idempotent: receiving
 * the same job twice produces the same result without side effects.
 */

import type { Job, WorkerFn } from "./jobQueue.js"
import { AnalysisType } from "./jobQueue.js"
import type { RuleEngineInput, RuleEngineResult } from "./ruleEngine.js"
import { scoreTransaction } from "./ruleEngine.js"
import type { BlacklistChecker } from "./blacklist.js"
import type { ForkClient, SimulateTxInput, SimulationDiff } from "./simulate.js"
import { simulateTransaction } from "./simulate.js"

// ---------------------------------------------------------------------------
// Rule Worker — deterministic, dependency-free scoring
// ---------------------------------------------------------------------------

export interface RuleWorkerDeps {
  /** The blacklist checker (#10). */
  blacklist: BlacklistChecker
}

export interface RuleJobPayload {
  /** Raw calldata of the proposed transaction. */
  data: string
  /** Value in wei. */
  value: string
  /** First-seen flag from the watcher. */
  isFirstSeenCounterparty: boolean
  /** Unverified/fresh flag from the watcher. */
  isUnverifiedOrFreshContract: boolean
  /** Historical p95 in wei (0n if unknown). */
  historicalP95Value: string
}

export function createRuleWorker(deps: RuleWorkerDeps): WorkerFn {
  return async (job: Job): Promise<RuleEngineResult> => {
    const payload = job.result as RuleJobPayload | null
    // The orchestrator stores the payload in result before the job is queued.
    const input: RuleJobPayload = payload ?? {
      data: "0x",
      value: "0",
      isFirstSeenCounterparty: false,
      isUnverifiedOrFreshContract: false,
      historicalP95Value: "0",
    }

    // Look up the counterparty blacklist verdict. If the lookup fails,
    // the checker returns "unknown" which is a no-op in the rule engine.
    const counterpartyBlacklist = await deps.blacklist.checkCounterparty(
      // We need the `to` address — it's not in the payload directly,
      // but the orchestrator puts it in the job's txHash metadata.
      // For now, decode from calldata if possible; the orchestrator
      // should also store it. We'll use a simple heuristic.
      extractToFromPayload(input),
    )

    const result = scoreTransaction({
      data: input.data,
      value: BigInt(input.value),
      isFirstSeenCounterparty: input.isFirstSeenCounterparty,
      isUnverifiedOrFreshContract: input.isUnverifiedOrFreshContract,
      historicalP95Value: BigInt(input.historicalP95Value),
      counterpartyBlacklist,
    })

    return result
  }
}

/**
 * Minimal attempt to extract the target address from calldata.
 * For setApprovalForAll / approve / permit the first ABI-encoded word
 * after the selector is the spender address. For plain transfers this
 * returns "unknown" which maps to "unknown" blacklist verdict (no-op).
 */
function extractToFromPayload(payload: RuleJobPayload): string {
  // If calldata is at least 10 (selector) + 64 (two 32-byte words) chars,
  // the first word after the selector is typically the target address.
  if (payload.data.length >= 10 + 64) {
    const word = payload.data.slice(10, 10 + 64)
    // The address sits in the low 20 bytes of the 32-byte word.
    const hex = word.slice(24) // last 40 hex chars
    if (/^[0-9a-fA-F]{40}$/.test(hex)) {
      return `0x${hex}`
    }
  }
  return "unknown"
}

// ---------------------------------------------------------------------------
// Simulation Worker — replays calldata against a fork
// ---------------------------------------------------------------------------

export interface SimulationWorkerDeps {
  forkClient: ForkClient
}

export interface SimulationJobPayload {
  /** The Safe address (from). */
  safeAddress: string
  /** The target contract (to). */
  to: string
  /** Value in wei. */
  value: string
  /** Raw calldata. */
  data: string
  /** Optional tokens to watch for allowance changes. */
  watchTokens?: SimulateTxInput["watchTokens"]
}

export function createSimulationWorker(deps: SimulationWorkerDeps): WorkerFn {
  return async (job: Job): Promise<SimulationDiff> => {
    const payload = job.result as SimulationJobPayload
    const diff = await simulateTransaction(deps.forkClient, {
      from: payload.safeAddress as `0x${string}`,
      to: payload.to as `0x${string}`,
      value: BigInt(payload.value),
      data: payload.data as `0x${string}`,
      watchTokens: payload.watchTokens,
    })
    return diff
  }
}

// ---------------------------------------------------------------------------
// Placeholder Workers — LLM and Wallet Risk (not yet implemented)
// ---------------------------------------------------------------------------

/**
 * Stub LLM worker. When #12 (LLM engine) is implemented, this will be
 * replaced with the real integration. For now, returns a safe default
 * so the pipeline doesn't break.
 */
export function createLlmWorker(): WorkerFn {
  return async (_job: Job) => {
    // TODO(#12): integrate with the actual LLM engine
    return { label: "low_risk" as const, score: 0, note: "LLM worker not yet implemented" }
  }
}

/**
 * Stub wallet-risk worker. When #8 (watcher history) is wired in, this
 * will perform wallet-level risk analysis.
 */
export function createWalletRiskWorker(): WorkerFn {
  return async (_job: Job) => {
    // TODO(#8 follow-up): implement wallet history analysis
    return { riskLevel: "unknown" as const, note: "Wallet risk worker not yet implemented" }
  }
}

// ---------------------------------------------------------------------------
// Convenience: register all default workers on a JobRunner
// ---------------------------------------------------------------------------

import type { JobRunner } from "./jobQueue.js"

export interface DefaultWorkerDeps extends RuleWorkerDeps, SimulationWorkerDeps {}

export function registerDefaultWorkers(runner: JobRunner, deps: DefaultWorkerDeps): void {
  runner.registerWorker(AnalysisType.RULES, createRuleWorker(deps))
  runner.registerWorker(AnalysisType.SIMULATION, createSimulationWorker(deps))
  runner.registerWorker(AnalysisType.LLM, createLlmWorker())
  runner.registerWorker(AnalysisType.WALLET_RISK, createWalletRiskWorker())
}
