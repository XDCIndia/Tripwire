/**
 * Deterministic semantic validation for compiled policies (issue #39).
 *
 * This is the gate that makes "invalid or conflicting policies are rejected
 * before deployment" true. It runs identically on policies that came from
 * natural language and on policies that came from a machine/LLM, so an LLM
 * can never slip something past the compiler that a human author couldn't.
 *
 * Anything this validator rejects is a hard error: the policy is never
 * deployed, never activated, and never partially enforced.
 */

import {
  AMOUNT_CURRENCIES,
  COMPARISONS,
  type CompiledPolicy,
  type PolicyRule,
  MAX_AMOUNT_DIGITS,
  MAX_DELAY_SECONDS,
  MAX_RULE_SOURCE_CHARS,
  RECIPIENT_KINDS,
} from "./policyTypes.js"

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/

export function validatePolicy(policy: CompiledPolicy): string[] {
  const issues: string[] = []
  if (policy.rules.length === 0) issues.push("policy has no rules")

  const catchAlls: PolicyRule[] = []
  const seen = new Set<string>()

  policy.rules.forEach((rule, index) => {
    const where = `rule ${index + 1}`

    if (rule.amount) {
      if (!COMPARISONS.includes(rule.amount.comparison)) {
        issues.push(`${where}: unsupported comparison "${rule.amount.comparison}"`)
      }
      if (!AMOUNT_CURRENCIES.includes(rule.amount.currency)) {
        issues.push(`${where}: unsupported currency "${rule.amount.currency}"`)
      }
      const value = rule.amount.value
      if (/^-?\d/.test(value) && (value.startsWith("-") || Number(value) === 0)) {
        issues.push(`${where}: amount must be greater than zero (got "${value}")`)
      } else if (!AMOUNT_PATTERN.test(value)) {
        issues.push(`${where}: amount "${value}" is not a positive number`)
      } else if (value.replace(".", "").length > MAX_AMOUNT_DIGITS) {
        issues.push(`${where}: amount "${value}" has too many digits (max ${MAX_AMOUNT_DIGITS})`)
      }
    }

    if (rule.recipient && !RECIPIENT_KINDS.includes(rule.recipient)) {
      issues.push(`${where}: unsupported recipient kind "${rule.recipient}"`)
    }

    if (rule.action === "DELAY") {
      if (rule.delaySeconds === null) {
        issues.push(`${where}: a delay rule must set delaySeconds`)
      } else if (!Number.isInteger(rule.delaySeconds) || rule.delaySeconds < 1 || rule.delaySeconds > MAX_DELAY_SECONDS) {
        issues.push(
          `${where}: delaySeconds must be an integer between 1 and ${MAX_DELAY_SECONDS} (got ${rule.delaySeconds})`,
        )
      }
    } else if (rule.delaySeconds !== null) {
      issues.push(`${where}: only delay rules may set delaySeconds (got ${rule.delaySeconds})`)
    }

    if (rule.fallback) {
      catchAlls.push(rule)
      if (rule.amount || rule.recipient) {
        issues.push(`${where}: a catch-all rule must not carry conditions`)
      }
      if (rule.action === "ALLOW") {
        issues.push(`${where}: an unconditional allow would fail open - Tripwire policies must fail closed`)
      }
    } else if (!rule.amount && !rule.recipient) {
      issues.push(`${where}: every rule must carry an amount limit, a recipient restriction, or be a catch-all`)
    }

    if (rule.source.length > MAX_RULE_SOURCE_CHARS) {
      issues.push(`${where}: source text is too long (max ${MAX_RULE_SOURCE_CHARS} characters)`)
    }

    // Two rules that mean exactly the same thing are either a paste error or
    // an LLM stutter - reject rather than let the duplicate silently change
    // nothing (or, worse, look like a second, independent protection).
    const fingerprint = [
      rule.action,
      rule.amount?.comparison ?? "-",
      rule.amount?.value ?? "-",
      rule.amount?.currency ?? "-",
      rule.recipient ?? "-",
      rule.delaySeconds ?? "-",
      rule.fallback,
    ].join("|")
    if (seen.has(fingerprint)) {
      issues.push(`${where}: duplicates rule ${[...seen].indexOf(fingerprint) + 1} exactly - remove the duplicate`)
    }
    seen.add(fingerprint)
  })

  if (catchAlls.length > 1) {
    const actions = [...new Set(catchAlls.map((rule) => rule.action))].join(" and ")
    issues.push(
      `policy has ${catchAlls.length} catch-all rules (${actions}) - "everything else" must be a single, last rule`,
    )
  }

  return issues
}
