/**
 * From structured policy to activation (issue #39).
 *
 * A `CompiledPolicy` is the deterministic, reviewable artifact a wallet
 * owner approves. This module is what turns it into something Tripwire can
 * actually act on, in three directions:
 *
 * 1. `explainPolicy` - the human-readable preview shown *before* activation,
 *    so owners never approve rules they cannot read back.
 * 2. `resolvePolicy` - converts human amounts to wei. This is the one place
 *    an exchange rate can enter, and it is required, explicit and validated
 *    - never silently assumed. A fiat amount without a rate is a hard error.
 * 3. `evaluateResolvedPolicy` / `verdictForEvaluation` - the deterministic
 *    per-transaction decision the relayer writes to RiskRegistry. No LLM is
 *    anywhere in this path: the LLM's only possible role ended at
 *    `compilePolicyFromJson`.
 *
 * Evaluation is first-match in rule order, catch-alls last, and when *no*
 * rule matches the policy fails closed to FREEZE - the on-chain Guard is
 * itself fail-closed (an UNSCORED transaction is blocked), so the two layers
 * agree on the default.
 */

import {
  type CompiledPolicy,
  type ConversionContext,
  type PolicyEvaluation,
  type PolicyGuardConfig,
  type PolicyRule,
  type PolicyTxView,
  type ResolvedPolicy,
  type ResolvedPolicyRule,
} from "./policyTypes.js"
import { RiskStatus, type OnChainVerdict } from "./verdict.js"

export class PolicyResolveError extends Error {
  constructor(
    public readonly issues: string[],
  ) {
    super(issues.join("\n"))
    this.name = "PolicyResolveError"
  }
}

// ---------------------------------------------------------------------------
// Human-readable rendering (preview)
// ---------------------------------------------------------------------------

const COMPARISON_TEXT: Record<string, string> = {
  "<": "below",
  "<=": "up to",
  ">": "above",
  ">=": "at least",
}

function currencyPrefix(currency: string): string {
  if (currency === "USD") return "$"
  return ""
}

function currencySuffix(currency: string): string {
  if (currency === "WEI") return " wei"
  if (currency === "XDC") return " XDC"
  return ""
}

/** "10000.5" -> "10,000.5", purely for display. */
export function formatAmount(value: string): string {
  const [intPart, fracPart] = value.split(".")
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fracPart === undefined ? grouped : `${grouped}.${fracPart}`
}

/** Renders one rule as a sentence a human can read back, e.g. "Allow
 * transactions below $500 to previously used recipients." */
export function renderRule(rule: PolicyRule): string {
  const verb = rule.action === "ALLOW" ? "Allow" : rule.action === "DELAY" ? "Delay" : "Freeze"
  const parts: string[] = [verb]

  if (rule.fallback) {
    parts.push("everything else")
  } else {
    parts.push("transactions")
    if (rule.amount) {
      parts.push(
        `${COMPARISON_TEXT[rule.amount.comparison]} ${currencyPrefix(rule.amount.currency)}${formatAmount(rule.amount.value)}${currencySuffix(rule.amount.currency)}`,
      )
    }
    if (rule.recipient === "known") parts.push("to previously used recipients")
    if (rule.recipient === "unknown") parts.push("to unknown recipients")
  }
  if (rule.action === "DELAY" && rule.delaySeconds !== null) {
    parts.push(`for ${renderDuration(rule.delaySeconds)}`)
  }
  return parts.join(" ") + "."
}

/** Renders seconds as the most readable whole unit that divides evenly. */
export function renderDuration(seconds: number): string {
  const units: Array<[number, string]> = [
    [7 * 24 * 60 * 60, "week"],
    [24 * 60 * 60, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
    [1, "second"],
  ]
  for (const [unitSeconds, name] of units) {
    if (seconds % unitSeconds === 0) {
      const count = seconds / unitSeconds
      return `${count} ${name}${count === 1 ? "" : "s"}`
    }
  }
  return `${seconds} seconds`
}

/** The full preview shown to the wallet owner before activation. */
export function explainPolicy(policy: CompiledPolicy): string {
  const lines = [
    `Your policy compiles to ${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"}. In order:`,
    ...policy.rules.map((rule, index) => `${index + 1}. ${renderRule(rule)}`),
    "Rules with no match are blocked (fail closed) - the Guard also blocks any transaction that has no recorded verdict.",
  ]
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Resolving human amounts to wei
// ---------------------------------------------------------------------------

/** Parses a non-negative decimal string into an integer scaled by 10^scale,
 * truncating any fractional digits beyond `scale`. Pure bigint math - no
 * floats anywhere, so "$0.1" can never drift. */
function decimalToScaled(value: string, scale: number): bigint {
  const [intPart, fracPart = ""] = value.split(".")
  const truncated = fracPart.slice(0, scale).padEnd(scale, "0")
  return BigInt(intPart) * 10n ** BigInt(scale) + BigInt(truncated === "" ? "0" : truncated)
}

function validateContext(ctx: ConversionContext): string[] {
  const issues: string[] = []
  if (ctx.nativeDecimals !== undefined && (!Number.isInteger(ctx.nativeDecimals) || ctx.nativeDecimals < 0 || ctx.nativeDecimals > 36)) {
    issues.push(`nativeDecimals must be an integer between 0 and 36 (got ${ctx.nativeDecimals})`)
  }
  if (ctx.usdPerNative !== undefined) {
    if (!/^\d+(?:\.\d+)?$/.test(ctx.usdPerNative) || Number(ctx.usdPerNative) <= 0) {
      issues.push(`usdPerNative must be a positive decimal string like "1" or "0.52" (got "${ctx.usdPerNative}")`)
    }
  }
  return issues
}

function resolveRule(rule: PolicyRule, ctx: ConversionContext, index: number): ResolvedPolicyRule {
  if (!rule.amount) {
    return {
      action: rule.action,
      amount: null,
      recipient: rule.recipient,
      delaySeconds: rule.delaySeconds,
      fallback: rule.fallback,
      source: rule.source,
    }
  }
  const { value, currency } = rule.amount
  const decimals = ctx.nativeDecimals ?? 18

  let wei: bigint
  if (currency === "WEI") {
    if (value.includes(".")) {
      throw new PolicyResolveError([`rule ${index + 1}: a wei amount cannot have decimals ("${value} wei")`])
    }
    wei = BigInt(value)
  } else if (currency === "XDC") {
    const fractionDigits = value.split(".")[1]?.length ?? 0
    if (fractionDigits > decimals) {
      throw new PolicyResolveError([
        `rule ${index + 1}: amount "${value} XDC" has more fractional digits than the native asset supports (${decimals})`,
      ])
    }
    wei = decimalToScaled(value, decimals)
  } else {
    // USD: requires an explicit market rate. Fail loudly - converting fiat
    // at a guessed rate would make the compiled limits wrong in one
    // direction or the other, which is exactly what must never happen.
    if (ctx.usdPerNative === undefined) {
      throw new PolicyResolveError([
        `rule ${index + 1} uses a USD amount ("${value}") but no rate was given - pass usdPerNative (e.g. "1" for 1 USD = 1 native token) to resolve the policy`,
      ])
    }
    const usdScaled = decimalToScaled(value, 18)
    const rateScaled = decimalToScaled(ctx.usdPerNative, 18)
    wei = (usdScaled * 10n ** 18n) / rateScaled
  }

  return { action: rule.action, amount: { comparison: rule.amount.comparison, wei, currency }, recipient: rule.recipient, delaySeconds: rule.delaySeconds, fallback: rule.fallback, source: rule.source }
}

function guardConfigOf(rules: ResolvedPolicyRule[]): PolicyGuardConfig {
  // Hard on-chain ceiling = the lowest freeze floor the policy declares
  // ("freeze above X" rules). Multiple freeze bands collapse to the most
  // protective one; no freeze rule means no ceiling (0 disables the check
  // in TripwireGuard). Delay-based and recipient-based rules cannot be a
  // Guard parameter - they are enforced through RiskRegistry verdicts,
  // which is exactly why the Guard also fails closed without a verdict.
  const freezeFloors = rules
    .filter((rule) => !rule.fallback && rule.action === "FREEZE" && rule.amount && (rule.amount.comparison === ">" || rule.amount.comparison === ">="))
    .map((rule) => rule.amount!.wei)
  const perTxLimit = freezeFloors.length > 0 ? freezeFloors.reduce((min, value) => (value < min ? value : min)) : 0n

  const delayRules = rules.filter((rule) => rule.action === "DELAY" && rule.delaySeconds !== null)
  const catchAllDelay = rules.find((rule) => rule.fallback && rule.action === "DELAY")
  const defaultDelaySeconds = catchAllDelay?.delaySeconds ?? delayRules[0]?.delaySeconds ?? null

  return { perTxLimit, rollingLimit: 0n, defaultDelaySeconds }
}

/** Converts a compiled policy into wei-denominated rules plus the Guard
 * parameters derived from it. Requires an explicit `usdPerNative` rate iff
 * any rule uses USD - otherwise it throws before anything is activated.
 */
export function resolvePolicy(policy: CompiledPolicy, ctx: ConversionContext = {}): ResolvedPolicy {
  const issues = validateContext(ctx)
  if (issues.length > 0) throw new PolicyResolveError(issues)

  const rules: ResolvedPolicyRule[] = []
  for (const [index, rule] of policy.rules.entries()) {
    rules.push(resolveRule(rule, ctx, index))
  }
  return { source: policy.source, rules, guardConfig: guardConfigOf(rules) }
}

// ---------------------------------------------------------------------------
// Deterministic per-transaction evaluation
// ---------------------------------------------------------------------------

function matches(rule: ResolvedPolicyRule, tx: PolicyTxView): boolean {
  if (rule.amount) {
    const { wei } = rule.amount
    const value = tx.value
    const comparison = rule.amount.comparison
    const amountHolds = comparison === "<" ? value < wei : comparison === "<=" ? value <= wei : comparison === ">" ? value > wei : value >= wei
    if (!amountHolds) return false
  }
  if (rule.recipient === "known" && !tx.recipientKnown) return false
  if (rule.recipient === "unknown" && tx.recipientKnown) return false
  return true
}

function outcomeOf(rule: ResolvedPolicyRule, now: number): PolicyEvaluation {
  return {
    action: rule.action,
    matched: rule,
    releaseAt: rule.action === "DELAY" ? now + (rule.delaySeconds ?? 0) : null,
  }
}

/** Applies a resolved policy to one proposed transaction. Returns the first
 * specific rule whose conditions hold, else the catch-all, else the
 * fail-closed default (FREEZE, no rule matched). */
export function evaluateResolvedPolicy(policy: ResolvedPolicy, tx: PolicyTxView, now: number = Math.floor(Date.now() / 1000)): PolicyEvaluation {
  for (const rule of policy.rules) {
    if (rule.fallback) continue
    if (matches(rule, tx)) return outcomeOf(rule, now)
  }
  for (const rule of policy.rules) {
    if (rule.fallback && matches(rule, tx)) return outcomeOf(rule, now)
  }
  return { action: "FREEZE", matched: null, releaseAt: null }
}

/** Convenience: resolve and evaluate in one step. */
export function evaluatePolicy(policy: CompiledPolicy, tx: PolicyTxView, ctx: ConversionContext = {}, now?: number): PolicyEvaluation {
  return evaluateResolvedPolicy(resolvePolicy(policy, ctx), tx, now)
}

/** Maps a policy decision onto the exact RiskRegistry verdict the relayer
 * writes - ALLOW -> LOW_RISK, DELAY -> DELAYED with its own releaseAt,
 * FREEZE -> HIGH_RISK. Mirrors verdict.ts's label mapping, but from a
 * policy action rather than a risk score. */
export function verdictForEvaluation(evaluation: PolicyEvaluation): OnChainVerdict {
  switch (evaluation.action) {
    case "ALLOW":
      return { status: RiskStatus.LOW_RISK, score: 0, releaseAt: 0 }
    case "DELAY":
      return { status: RiskStatus.DELAYED, score: 0, releaseAt: evaluation.releaseAt ?? 0 }
    case "FREEZE":
      return { status: RiskStatus.HIGH_RISK, score: 100, releaseAt: 0 }
  }
}
