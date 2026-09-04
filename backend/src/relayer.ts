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
 * Thrown when a verdict submission mined but reverted. This is a
 * deterministic failure - resubmitting the same verdict will revert the
 * same way - so the relayer must NOT retry it (unlike transient network
 * errors, which it must).
 */
export class VerdictRevertedError extends Error {
  constructor(
    readonly txHash: string,
    readonly transaction: string,
  ) {
    super(`submitVerdict for ${txHash} reverted (tx ${transaction})`)
    this.name = "VerdictRevertedError"
  }
}

export interface VerdictRelayerOptions {
  /**
   * Total submission attempts per verdict before giving up. Transient
   * failures (RPC down, connection reset) are retried; a mined revert is
   * not. Default 3.
   */
  maxAttempts?: number
  /** Base backoff in ms between attempts - attempt N waits backoffMs * 2^(N-1). Default 500. */
  backoffMs?: number
  /** Injectable sleep for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
 *
 * Submission is retried on transient failure: a verdict that failed to land
 * because the RPC hiccuped must not be abandoned - that would leave the
 * transaction UNSCORED on-chain, the one outcome this component exists to
 * prevent. Resubmission is safe precisely because the contract has no
 * "already scored" guard. The verdict is computed once and resubmitted
 * unchanged, so retries can never disagree with the first attempt.
 */
export class VerdictRelayer {
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private cachedDelayWindow: number | undefined
  private delayWindowFetchedAt = 0

  constructor(
    private readonly client: RiskRegistryClient,
    options: VerdictRelayerOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3
    this.backoffMs = options.backoffMs ?? 500
    this.sleep = options.sleep ?? defaultSleep
  }

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
    await this.submitWithRetry(txHash, verdict)
    return verdict
  }

  async submitFinal(
    txHash: `0x${string}`,
    ruleResult: RuleEngineResult,
    llm: LlmVerdict | undefined,
  ): Promise<OnChainVerdict> {
    const verdict = finalVerdict(ruleResult, llm, { delaySeconds: await this.effectiveDelayWindow(Date.now()) })
    await this.submitWithRetry(txHash, verdict)
    return verdict
  }

  private async submitWithRetry(txHash: `0x${string}`, verdict: OnChainVerdict): Promise<void> {
    let lastError: unknown

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.client.submitVerdict(txHash, verdict)
        return
      } catch (err) {
        lastError = err
        // A mined revert cannot be fixed by resubmitting - fail now so the
        // caller's alerting sees the real error immediately.
        if (err instanceof VerdictRevertedError) throw err
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs * 2 ** (attempt - 1))
        }
      }
    }

    throw lastError
  }
}