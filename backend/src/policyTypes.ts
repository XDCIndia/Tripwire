/**
 * The deterministic, language-agnostic policy model (issue #39).
 *
 * Tripwire's "key principle" is: an LLM *interprets* a wallet owner's plain
 * English policy, but the smart contract *enforces* it. Everything in this
 * directory is the middle of that sentence: it converts natural language (or
 * machine/LLM-produced JSON) into one canonical, ordered, JSON-serializable
 * structure, validates it, and - once validated - maps it onto the Guard
 * controls that actually exist on-chain (spending limits, cooling-off delays,
 * and blocks/freezes via RiskRegistry verdicts).
 *
 * Deliberately no bigints and no exchange rates in this representation: the
 * human amounts stay human ("$500", "10,000 XDC") so a policy can be parsed,
 * previewed and explained before any currency conversion happens. Converting
 * to wei is a separate, later step (see policyMapper.ts) that requires
 * explicit rate input - never a silent guess.
 */

export const POLICY_ACTIONS = ["ALLOW", "DELAY", "FREEZE"] as const
/** Severity order. Evaluation is fail-closed: ties between matching rules
 * resolve toward the *strongest* action, never the weakest. */
export const ACTION_SEVERITY: Record<PolicyAction, number> = { ALLOW: 0, DELAY: 1, FREEZE: 2 }
export type PolicyAction = (typeof POLICY_ACTIONS)[number]

export const AMOUNT_CURRENCIES = ["USD", "XDC", "WEI"] as const
export type AmountCurrency = (typeof AMOUNT_CURRENCIES)[number]

export const COMPARISONS = ["<", "<=", ">", ">="] as const
export type Comparison = (typeof COMPARISONS)[number]

export const RECIPIENT_KINDS = ["known", "unknown"] as const
export type RecipientKind = (typeof RECIPIENT_KINDS)[number]

/** A numeric bound on the transaction's value, kept in the unit the owner
 * actually wrote. `value` is a decimal string on purpose - it round-trips
 * through JSON without float drift and is only turned into a bigint (wei)
 * at resolve time, together with an explicit currency rate. */
export interface AmountCondition {
  comparison: Comparison
  /** Human-scale decimal string, e.g. "500" or "10000.5". Always > 0. */
  value: string
  currency: AmountCurrency
  /** The exact text the amount came from, kept for errors and explanations. */
  source: string
}

/** One enforceable statement of a policy, e.g. the sentence it was parsed
 * from. Conditions within a rule are ANDed: `amount` *and* `recipient` must
 * both hold for the rule to match a transaction. */
export interface PolicyRule {
  action: PolicyAction
  /** Null means "any amount". */
  amount: AmountCondition | null
  /** Null means "any recipient". `known` = previously used by this wallet. */
  recipient: RecipientKind | null
  /** Cooling-off length in seconds. Required iff action is DELAY, and must
   * be null for every other action. */
  delaySeconds: number | null
  /** "everything else" catch-all. Matches only when no specific rule
   * matched, which is what makes "allow X; delay everything else" work as
   * an ordered chain instead of the catch-all shadowing everything. */
  fallback: boolean
  /** The human clause this rule came from (or a rendering of it, for rules
   * compiled from JSON). Used for previews and error messages. */
  source: string
}

/** The canonical structured policy. Versioned so that future grammar changes
 * never silently reinterpret an older stored policy. */
export interface CompiledPolicy {
  version: 1
  /** The exact natural-language text this policy was compiled from, if any. */
  source: string
  /** Specific rules first (in author order), catch-alls last. */
  rules: PolicyRule[]
}

/** Everything resolvePolicy needs to turn human amounts into wei. Nothing
 * here may ever be a silent default: resolving a fiat amount without
 * `usdPerNative` is a hard, deterministic error. */
export interface ConversionContext {
  /** Decimals of the native asset. Defaults to 18 (XDC/ETH-style). */
  nativeDecimals?: number
  /** Market rate: how many USD one native token buys, as a decimal string,
   * e.g. "1" or "0.52". Required iff any rule carries a USD amount. */
  usdPerNative?: string
}

/** The exact view of a proposed transaction the deterministic evaluator
 * needs. Everything else about the tx (calldata shape, contract freshness,
 * ...) stays with the existing rule engine - this is purely the policy's
 * own vocabulary. */
export interface PolicyTxView {
  /** Transfer value in wei. */
  value: bigint
  /** True if this wallet has transacted with the recipient before. */
  recipientKnown: boolean
}

/** A rule whose amounts have been converted to wei. */
export interface ResolvedPolicyRule extends Omit<PolicyRule, "amount"> {
  amount: { comparison: Comparison; wei: bigint; currency: AmountCurrency } | null
}

/** The Guard-facing surface of an activated policy. `perTxLimit` and
 * `rollingLimit` are the exact arguments TripwireGuard.setLimits takes (0 =
 * disabled); the delay is what the relayer stamps on DELAYED verdicts. */
export interface PolicyGuardConfig {
  /** Hard per-transaction ceiling in wei, from the policy's freeze-on-amount
   * rules (lowest floor wins, fail-closed). 0 disables the check. */
  perTxLimit: bigint
  /** Rolling 24h ceiling in wei. The current grammar has no daily-limit
   * construct yet, so this is always 0 until one exists. */
  rollingLimit: bigint
  /** Cooling-off length the relayer applies to DELAYED verdicts, in seconds.
   * Taken from the policy's delay rule(s). Null if the policy never delays. */
  defaultDelaySeconds: number | null
}

export interface ResolvedPolicy {
  source: string
  rules: ResolvedPolicyRule[]
  guardConfig: PolicyGuardConfig
}

/** Deterministic outcome of applying a policy to one transaction. */
export interface PolicyEvaluation {
  action: PolicyAction
  /** The rule that produced the action; null when no rule matched and the
   * fail-closed default applied. */
  matched: ResolvedPolicyRule | null
  /** When action is DELAY: epoch seconds the transaction may execute after. */
  releaseAt: number | null
}

/** Cap a policy so no single input (or runaway LLM response) can exhaust
 * downstream processing. */
export const MAX_POLICY_CHARS = 20_000
export const MAX_RULES_PER_POLICY = 50
export const MAX_RULE_SOURCE_CHARS = 500
export const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60 // 30 days
export const MAX_AMOUNT_DIGITS = 64
