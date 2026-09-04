/**
 * Policy compiler facade (issue #39).
 *
 * Two entry points, one destination: `compilePolicy` turns a wallet owner's
 * plain English into the canonical structured policy; `compilePolicyFromJson`
 * turns a machine/LLM-produced policy document into the exact same structure.
 * Both run the same deterministic validation, so the LLM's role is strictly
 * interpretive - it can never produce an enforceable rule that a human could
 * not also write, and it can never skip the validation gate.
 *
 * The destination (`CompiledPolicy`) is deliberately free of bigints and
 * exchange rates - see policyMapper.ts for the resolve step that turns it
 * into Guard parameters and per-transaction decisions at activation time.
 */

import { PolicyParseError, parsePolicyText } from "./nlPolicyCompiler.js"
import {
  type AmountCondition,
  type AmountCurrency,
  type Comparison,
  type CompiledPolicy,
  type PolicyAction,
  type PolicyRule,
  type RecipientKind,
  AMOUNT_CURRENCIES,
  COMPARISONS,
  MAX_POLICY_CHARS,
  MAX_RULES_PER_POLICY,
  RECIPIENT_KINDS,
} from "./policyTypes.js"
import { validatePolicy } from "./policyValidator.js"

export class PolicyCompileError extends Error {
  constructor(
    public readonly issues: string[],
  ) {
    super(issues.join("\n"))
    this.name = "PolicyCompileError"
  }
}

/** Catch-all rules only ever apply when no specific rule matched, so they
 * are always ordered last regardless of where in the text the owner wrote
 * them ("allow X; delay everything else" reads naturally in that order, and
 * "delay everything else; then freeze over $10k" would still freeze first).
 * Stable: relative order is preserved within each group. */
function orderRules(rules: PolicyRule[]): PolicyRule[] {
  return [...rules.filter((rule) => !rule.fallback), ...rules.filter((rule) => rule.fallback)]
}

/** Compile a plain-English wallet policy into the canonical structured form.
 *
 * @throws PolicyCompileError when any sentence is unparseable, any rule is
 * invalid, or rules conflict - nothing is ever partially accepted.
 */
export function compilePolicy(text: string): CompiledPolicy {
  const trimmed = text.trim()
  if (!trimmed) throw new PolicyCompileError(["policy text is empty"])
  if (trimmed.length > MAX_POLICY_CHARS) {
    throw new PolicyCompileError([`policy text is too long (max ${MAX_POLICY_CHARS} characters)`])
  }

  let rules: PolicyRule[]
  try {
    rules = parsePolicyText(trimmed)
  } catch (error) {
    if (error instanceof PolicyParseError) {
      throw new PolicyCompileError([error.message])
    }
    throw error
  }

  const policy: CompiledPolicy = { version: 1, source: trimmed, rules: orderRules(rules) }
  const issues = validatePolicy(policy)
  if (issues.length > 0) throw new PolicyCompileError(issues)
  return policy
}

// ---------------------------------------------------------------------------
// Machine/LLM JSON path
// ---------------------------------------------------------------------------

/** Shape an LLM (or any machine caller) is allowed to hand in. It mirrors
 * CompiledPolicy exactly, minus fields that only the parser fills in. */
interface JsonAmount {
  comparison?: string
  /** Decimal string or number; always > 0. */
  value?: string | number
  currency?: string
}

interface JsonRule {
  action: string
  amount?: JsonAmount | null
  recipient?: string | null
  delaySeconds?: number | null
  fallback?: boolean
  source?: string
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(["version", "source", "rules"])
const ALLOWED_RULE_KEYS = new Set(["action", "amount", "recipient", "delaySeconds", "fallback", "source"])
const ALLOWED_AMOUNT_KEYS = new Set(["comparison", "value", "currency"])

const CURRENCIES = new Set<string>(AMOUNT_CURRENCIES)
const COMPARISON_SET = new Set<string>(COMPARISONS)
const RECIPIENT_KIND_SET = new Set<string>(RECIPIENT_KINDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Every deviation from the schema is reported at once, with the exact path
 * (e.g. `rules[2].amount.value`), so an LLM integrator sees precisely what
 * to fix instead of playing whack-a-mole. */
function schemaIssues(raw: unknown): string[] {
  const issues: string[] = []
  if (!isRecord(raw)) return ["policy must be a JSON object"]

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) issues.push(`unknown top-level key "${key}"`)
  }
  if (raw.version !== undefined && raw.version !== 1) {
    issues.push(`unsupported policy version ${String(raw.version)} - only version 1 is understood`)
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string") issues.push("source must be a string")
    else if (raw.source.length > MAX_POLICY_CHARS) issues.push(`source is too long (max ${MAX_POLICY_CHARS} characters)`)
  }

  if (!Array.isArray(raw.rules)) {
    issues.push("rules must be an array")
    return issues
  }
  if (raw.rules.length === 0) issues.push("rules must not be empty")
  if (raw.rules.length > MAX_RULES_PER_POLICY) {
    issues.push(`too many rules (max ${MAX_RULES_PER_POLICY})`)
  }

  raw.rules.forEach((rule, index) => {
    const path = `rules[${index}]`
    if (!isRecord(rule)) {
      issues.push(`${path} must be an object`)
      return
    }
    for (const key of Object.keys(rule)) {
      if (!ALLOWED_RULE_KEYS.has(key)) issues.push(`unknown key "${path}.${key}"`)
    }
    if (typeof rule.action !== "string" || !["ALLOW", "DELAY", "FREEZE"].includes(rule.action)) {
      issues.push(`${path}.action must be one of ALLOW, DELAY, FREEZE`)
    }

    if (rule.amount !== undefined && rule.amount !== null) {
      if (!isRecord(rule.amount)) {
        issues.push(`${path}.amount must be an object`)
      } else {
        for (const key of Object.keys(rule.amount)) {
          if (!ALLOWED_AMOUNT_KEYS.has(key)) issues.push(`unknown key "${path}.amount.${key}"`)
        }
        const { comparison, value, currency } = rule.amount
        if (comparison !== undefined && (typeof comparison !== "string" || !COMPARISON_SET.has(comparison))) {
          issues.push(`${path}.amount.comparison must be one of ${COMPARISONS.join(", ")}`)
        }
        if (value !== undefined && typeof value !== "string" && typeof value !== "number") {
          issues.push(`${path}.amount.value must be a number or numeric string`)
        }
        if (currency !== undefined && (typeof currency !== "string" || !CURRENCIES.has(currency))) {
          issues.push(`${path}.amount.currency must be one of ${AMOUNT_CURRENCIES.join(", ")}`)
        }
      }
    }

    if (
      rule.recipient !== undefined &&
      rule.recipient !== null &&
      (typeof rule.recipient !== "string" || !RECIPIENT_KIND_SET.has(rule.recipient))
    ) {
      issues.push(`${path}.recipient must be one of ${RECIPIENT_KINDS.join(", ")}, or null`)
    }
    if (rule.delaySeconds !== undefined && rule.delaySeconds !== null && !Number.isInteger(rule.delaySeconds)) {
      issues.push(`${path}.delaySeconds must be an integer number of seconds`)
    }
    if (rule.fallback !== undefined && typeof rule.fallback !== "boolean") {
      issues.push(`${path}.fallback must be a boolean`)
    }
    if (rule.source !== undefined && typeof rule.source !== "string") {
      issues.push(`${path}.source must be a string`)
    }
  })

  return issues
}

function ruleFromJson(json: JsonRule, index: number): PolicyRule {
  const rawAmount = json.amount === undefined || json.amount === null ? null : json.amount
  const amount: AmountCondition | null = rawAmount
    ? {
        comparison: (rawAmount.comparison ?? "<") as Comparison,
        value: String(rawAmount.value),
        currency: (rawAmount.currency ?? "XDC") as AmountCurrency,
        source: `amount ${String(rawAmount.value)} ${rawAmount.currency ?? "XDC"}`,
      }
    : null

  return {
    action: json.action as PolicyAction,
    amount,
    recipient: (json.recipient ?? null) as RecipientKind | null,
    delaySeconds: json.delaySeconds ?? null,
    fallback: json.fallback ?? false,
    source: json.source ?? `rule ${index + 1} (from machine-readable policy)`,
  }
}

/** Compile a machine/LLM-produced policy document into the canonical
 * structured form. Strict by design: unknown fields, wrong types, out-of
 * range values and semantic conflicts all fail with precise messages. The
 * caller (an LLM wrapper, typically) is responsible for extracting clean
 * JSON first - this function never executes anything and never talks to a
 * model; it only validates and normalizes.
 *
 * @throws PolicyCompileError listing every schema and semantic issue found.
 */
export function compilePolicyFromJson(raw: unknown): CompiledPolicy {
  const issues = schemaIssues(raw)
  if (issues.length > 0) throw new PolicyCompileError(issues)

  const document = raw as { source?: string; rules: JsonRule[] }
  const rules = document.rules.map(ruleFromJson)
  const policy: CompiledPolicy = {
    version: 1,
    source: document.source ?? "(machine-readable policy)",
    rules: orderRules(rules),
  }
  const semanticIssues = validatePolicy(policy)
  if (semanticIssues.length > 0) throw new PolicyCompileError(semanticIssues)
  return policy
}
