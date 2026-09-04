import type { RuleEngineResult } from "./ruleEngine.js"
import {
  type LlmVerdict,
  type OnChainVerdict,
  DEFAULT_DELAY_SECONDS,
  finalVerdict,
  verdictFromRuleEngine,
} from "./verdict.js"

/** The contract calls this module needs - implemented for real against RiskRegistry.sol via viem. */
export interface RiskRegistryClient {
  submitVerdict(txHash: `0x${string}`, verdict: OnChainVerdict): Promise<void>
  /**
   * The on-chain default delay window in seconds (RiskRegistry.defaultDelayWindow).
   * 0 means the registry has no owner-configured window and the relayer's own
   * default applies.
   */
  delayWindow(): Promise<number>
}

/**
 * How long a registry-configured delay window is cached before being
 * re-read. Bounds the fast path to one RPC read per minute rather than one
 * per verdict, while still picking up owner changes from the dashboard
 * panel within a minute.
 */
export const DELAY_WINDOW_REFRESH_MS = 60_000

/**
 * Writes verdicts to RiskRegistry. Two-phase by design: `submitFast` posts
 * the rule-engine-only verdict the moment it's computed (no LLM call, and
 * no per-verdict I/O either - the on-chain delay window is cached and
 * refreshed at most once a minute); `submitFinal` posts an updated verdict
 * later if/when an LLM result (#12) comes in, which is allowed to simply
 * overwrite the fast one since RiskRegistry.submitVerdict has no "already
 * scored" guard. A transaction this relayer has seen is never left
 * UNSCORED - the fast path alone guarantees that.
 */
export class VerdictRelayer {
  private cachedDelayWindow: number | undefined
  private delayWindowFetchedAt = 0

  constructor(private readonly client: RiskRegistryClient) {}

  private async effectiveDelayWindow(now: number): Promise<number> {
    if (this.cachedDelayWindow === undefined || now - this.delayWindowFetchedAt >= DELAY_WINDOW_REFRESH_MS) {
      const onChain = await this.client.delayWindow()
      this.cachedDelayWindow = onChain > 0 ? onChain : DEFAULT_DELAY_SECONDS
      this.delayWindowFetchedAt = now
    }
    return this.cachedDelayWindow
  }

  async submitFast(txHash: `0x${string}`, ruleResult: RuleEngineResult): Promise<OnChainVerdict> {
    const verdict = verdictFromRuleEngine(ruleResult, { delaySeconds: await this.effectiveDelayWindow(Date.now()) })
    await this.client.submitVerdict(txHash, verdict)
    return verdict
  }

  async submitFinal(
    txHash: `0x${string}`,
    ruleResult: RuleEngineResult,
    llm: LlmVerdict | undefined,
  ): Promise<OnChainVerdict> {
    const verdict = finalVerdict(ruleResult, llm, { delaySeconds: await this.effectiveDelayWindow(Date.now()) })
    await this.client.submitVerdict(txHash, verdict)
    return verdict
  }
}
