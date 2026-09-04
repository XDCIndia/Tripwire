import type { RuleEngineResult } from "./ruleEngine.js"
import type { SimulationDiff } from "./simulate.js"
import type { LlmVerdict } from "./verdict.js"

/**
 * Tri-state counterparty reputation, mirroring the blacklist checker's
 * verdict shape without depending on it landing first. Kept structural: any
 * source that classifies a counterparty as malicious/clean/unknown fits.
 */
export type CounterpartyReputation = "malicious" | "clean" | "unknown"

/**
 * Contextual-judgment layer (issue #12): a structured-output call to the
 * Claude API that re-judges a proposed Safe transaction with context the
 * deterministic rule engine can't see - counterparty metadata, the fork
 * simulation diff, and the portfolio-level picture.
 *
 * Design contract, matching issue #12's acceptance criteria:
 *
 * 1. Structured output - the call forces a `record_risk_verdict` tool whose
 *    input schema IS the verdict schema (`{ txHash, score, label, reasons[],
 *    recommended_action }`), so the model cannot answer in prose.
 * 2. Validated - `parseLlmVerdict` re-checks every field against the schema
 *    and rejects anything malformed or out of range. Nothing unvalidated
 *    ever reaches the relayer.
 * 3. Additive, never blocking - EVERY failure mode (no API key, network
 *    error, timeout, non-2xx, malformed body, schema mismatch) collapses to
 *    `undefined`. `finalVerdict()` then falls back to the rule-engine
 *    verdict, so this call can never leave a transaction unscored, delay
 *    the fast path, or weaken the deterministic floor.
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"

/**
 * Fast + cheap on purpose: the fast-path verdict is already on-chain before
 * this call starts, so latency here only affects how quickly the *refined*
 * verdict lands, never whether a verdict exists. Override with
 * ANTHROPIC_MODEL or options.model.
 */
export const DEFAULT_MODEL = "claude-3-5-haiku-20241022"

const VERDICT_TOOL_NAME = "record_risk_verdict"

const RECORD_VERDICT_TOOL = {
  name: VERDICT_TOOL_NAME,
  description:
    "Record the final contextual risk verdict for a proposed Safe wallet transaction. " +
    "score is 0-100 (higher is riskier); label is low_risk/medium_risk/high_risk; " +
    "recommended_action is allow/delay/block/freeze.",
  input_schema: {
    type: "object" as const,
    properties: {
      txHash: { type: "string" as const },
      score: { type: "number" as const, description: "0-100, higher is riskier" },
      label: { type: "string" as const, enum: ["low_risk", "medium_risk", "high_risk"] as const },
      reasons: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "One short sentence per contextual concern, human-readable",
      },
      recommended_action: {
        type: "string" as const,
        enum: ["allow", "delay", "block", "freeze"] as const,
      },
    },
    required: ["txHash", "score", "label", "reasons", "recommended_action"],
  },
}

const SYSTEM_PROMPT = [
  "You are the contextual risk engine for Tripwire, a guardian module that protects a Gnosis Safe",
  "wallet from malicious transactions before they execute.",
  "",
  "A deterministic rule engine has already scored this transaction from hard signals (calldata",
  "selectors, blacklist status, value anomalies, fork-simulation diffs). Your job is to re-judge",
  "the SAME transaction with the full context in front of you and either confirm the rule engine",
  "or adjust the score when the context justifies it.",
  "",
  "Ground rules:",
  "- The rule engine's matched signals are facts, not suggestions to ignore. Only deviate from its",
  "  label when the context clearly explains why the hard signals over- or under-state the risk.",
  "- A mined-revert or a hidden allowance/balance change in the simulation diff is strong evidence",
  "  of a drainer pattern: score it high_risk and recommend block.",
  "- An unlimited approval (approve uint256-max or setApprovalForAll) to a fresh, unverified, or",
  "  blacklist-unknown contract is at least medium_risk: recommend delay so a human can look.",
  "- If the context gives you nothing beyond what the rule engine already saw, keep its label and",
  "  say so in reasons - do not invent risk.",
  "- Every reason must be one short, human-readable sentence suitable for a dashboard.",
].join("\n")

export interface LlmReasoningInput {
  txHash: string
  ruleResult: RuleEngineResult
  simulationDiff?: SimulationDiff
  counterpartyBlacklist?: CounterpartyReputation
}

export interface LlmReasoningOptions {
  /** Defaults to ANTHROPIC_API_KEY. Missing key => undefined (LLM step skipped). */
  apiKey?: string
  /** Defaults to ANTHROPIC_MODEL, then DEFAULT_MODEL. */
  model?: string
  /** Hard cap on the whole call. Default 15s. Timeout => undefined (fallback). */
  timeoutMs?: number
  maxTokens?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Builds the deterministic JSON context document the model judges. */
export function buildReasoningContext(input: LlmReasoningInput): string {
  const sim = input.simulationDiff
  return JSON.stringify(
    {
      transaction: { txHash: input.txHash },
      ruleEngine: {
        score: input.ruleResult.score,
        label: input.ruleResult.label,
        matchedSignals: input.ruleResult.matchedSignals,
      },
      counterpartyBlacklist: input.counterpartyBlacklist ?? "unknown",
      simulation: !sim
        ? undefined
        : {
            callSucceeded: sim.success,
            balanceDeltaWei: (sim.balanceAfter - sim.balanceBefore).toString(),
            newAllowances: sim.newAllowances.map((a) => ({
              token: a.token,
              spender: a.spender,
              standard: a.standard,
              before: a.before.toString(),
              after: a.after.toString(),
            })),
          },
    },
    null,
    2,
  )
}

const VALID_LABELS = new Set(["low_risk", "medium_risk", "high_risk"])
const VALID_ACTIONS = new Set(["allow", "delay", "block", "freeze"])

/**
 * Re-validates raw model output against the verdict schema. Returns
 * undefined for ANY mismatch - a half-valid verdict is worse than no
 * verdict, because the rule-engine fallback is always well-formed.
 */
export function parseLlmVerdict(raw: unknown): LlmVerdict | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const v = raw as Record<string, unknown>

  if (typeof v.txHash !== "string" || v.txHash.length === 0) return undefined
  if (typeof v.score !== "number" || !Number.isFinite(v.score) || v.score < 0 || v.score > 100) {
    return undefined
  }
  if (typeof v.label !== "string" || !VALID_LABELS.has(v.label)) return undefined
  if (
    !Array.isArray(v.reasons) ||
    v.reasons.length === 0 ||
    v.reasons.length > 20 ||
    !v.reasons.every((r) => typeof r === "string" && r.trim().length > 0)
  ) {
    return undefined
  }
  if (typeof v.recommended_action !== "string" || !VALID_ACTIONS.has(v.recommended_action)) {
    return undefined
  }

  return {
    score: v.score,
    label: v.label as LlmVerdict["label"],
    reasons: v.reasons as string[],
    recommendedAction: v.recommended_action,
  }
}

/**
 * The only entry point. NEVER throws: every failure mode logs and resolves
 * to `undefined`, which callers pass to `finalVerdict()` to get the
 * deterministic fallback.
 */
export async function reasonAboutTx(
  input: LlmReasoningInput,
  options: LlmReasoningOptions = {},
): Promise<LlmVerdict | undefined> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn("[llm] ANTHROPIC_API_KEY not set - skipping contextual reasoning (rule-engine verdict stands)")
    return undefined
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? 1024,
        system: SYSTEM_PROMPT,
        tools: [RECORD_VERDICT_TOOL],
        tool_choice: { type: "tool", name: VERDICT_TOOL_NAME },
        messages: [{ role: "user", content: buildReasoningContext(input) }],
      }),
    })

    if (!response.ok) {
      console.warn(`[llm] Claude API returned ${response.status} - falling back to rule-engine verdict`)
      return undefined
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; name?: string; input?: unknown }>
    }
    const block = payload.content?.find((b) => b.type === "tool_use" && b.name === VERDICT_TOOL_NAME)
    if (!block) {
      console.warn("[llm] response carried no record_risk_verdict tool use - falling back to rule-engine verdict")
      return undefined
    }

    const verdict = parseLlmVerdict(block.input)
    if (!verdict) {
      console.warn("[llm] model output failed schema validation - falling back to rule-engine verdict")
      return undefined
    }
    return verdict
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[llm] reasoning call failed (${reason}) - falling back to rule-engine verdict`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
