import { describe, expect, it, vi } from "vitest"

import { buildReasoningContext, parseLlmVerdict, reasonAboutTx, type LlmReasoningInput } from "../src/llmReasoning.js"
import type { RuleEngineResult } from "../src/ruleEngine.js"
import type { SimulationDiff } from "../src/simulate.js"

const TX_HASH = "0xabc1230000000000000000000000000000000000000000000000000000000000"

const RULE_RESULT: RuleEngineResult = {
  score: 40,
  label: "medium_risk",
  matchedSignals: ["UNLIMITED_APPROVE", "BLACKLIST_UNKNOWN"],
}

const SIM_DIFF: SimulationDiff = {
  balanceBefore: 10n ** 18n,
  balanceAfter: 10n ** 18n - 5n * 10n ** 17n,
  success: true,
  ownershipChanges: [],
  newAllowances: [
    {
      token: "0xToken000000000000000000000000000000000000",
      spender: "0xSpender00000000000000000000000000000000",
      standard: "erc20",
      before: 0n,
      after: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    },
  ],
}

const INPUT: LlmReasoningInput = {
  txHash: TX_HASH,
  ruleResult: RULE_RESULT,
  simulationDiff: SIM_DIFF,
  counterpartyBlacklist: "unknown",
}

/** A canned Claude /v1/messages response carrying a well-formed tool_use block. */
function claudeResponse(input: Record<string, unknown>, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      content: [{ type: "tool_use", id: "toolu_test", name: "record_risk_verdict", input }],
    }),
    { status, headers: { "content-type": "application/json" } },
  )
}

const VALID_INPUT = {
  txHash: TX_HASH,
  score: 75,
  label: "high_risk",
  reasons: ["Unlimited approval to a contract with no prior history is a classic drainer primitive."],
  recommended_action: "block",
}

describe("parseLlmVerdict (schema validation)", function () {
  it("accepts a fully valid payload", function () {
    expect(parseLlmVerdict(VALID_INPUT)).toEqual({
      score: 75,
      label: "high_risk",
      reasons: VALID_INPUT.reasons,
      recommendedAction: "block",
    })
  })

  it("rejects non-objects", function () {
    expect(parseLlmVerdict(undefined)).toBeUndefined()
    expect(parseLlmVerdict(null)).toBeUndefined()
    expect(parseLlmVerdict("high_risk")).toBeUndefined()
    expect(parseLlmVerdict([VALID_INPUT])).toBeUndefined()
  })

  it("rejects an out-of-range score", function () {
    expect(parseLlmVerdict({ ...VALID_INPUT, score: 101 })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, score: -1 })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, score: "75" })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, score: Number.NaN })).toBeUndefined()
  })

  it("rejects an unknown label", function () {
    expect(parseLlmVerdict({ ...VALID_INPUT, label: "sketchy" })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, label: "HIGH_RISK" })).toBeUndefined()
  })

  it("rejects malformed reasons", function () {
    expect(parseLlmVerdict({ ...VALID_INPUT, reasons: [] })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, reasons: ["ok", 42] })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, reasons: ["", "x"] })).toBeUndefined()
    expect(parseLlmVerdict({ ...VALID_INPUT, reasons: "a single string" })).toBeUndefined()
  })

  it("rejects an unknown recommended_action", function () {
    expect(parseLlmVerdict({ ...VALID_INPUT, recommended_action: "hold" })).toBeUndefined()
  })

  it("rejects a missing txHash", function () {
    const { txHash: _omitted, ...rest } = VALID_INPUT
    expect(parseLlmVerdict(rest)).toBeUndefined()
  })
})

describe("buildReasoningContext", function () {
  it("serializes bigint fields as decimal strings", function () {
    const context = JSON.parse(buildReasoningContext(INPUT)) as {
      ruleEngine: { score: number; matchedSignals: string[] }
      counterpartyBlacklist: string
      simulation: { balanceDeltaWei: string; newAllowances: Array<{ after: string }> }
    }
    expect(context.ruleEngine.score).toBe(40)
    expect(context.ruleEngine.matchedSignals).toEqual(RULE_RESULT.matchedSignals)
    expect(context.counterpartyBlacklist).toBe("unknown")
    expect(typeof context.simulation.balanceDeltaWei).toBe("string")
    expect(context.simulation.newAllowances[0].after).toBe(SIM_DIFF.newAllowances[0].after.toString())
  })

  it("omits the simulation section when no diff was provided", function () {
    const context = JSON.parse(buildReasoningContext({ txHash: TX_HASH, ruleResult: RULE_RESULT })) as Record<
      string,
      unknown
    >
    expect(context.simulation).toBeUndefined()
    expect(context.counterpartyBlacklist).toBe("unknown")
  })
})

describe("reasonAboutTx (issue #12: additive, never blocking)", function () {
  it("returns the parsed verdict on a well-formed tool_use response", async function () {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => claudeResponse(VALID_INPUT))
    const verdict = await reasonAboutTx(INPUT, { apiKey: "test-key", fetchImpl })
    expect(verdict).toEqual({
      score: 75,
      label: "high_risk",
      reasons: VALID_INPUT.reasons,
      recommendedAction: "block",
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("sends the forced tool_choice and verdict schema", async function () {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => claudeResponse(VALID_INPUT))
    await reasonAboutTx(INPUT, { apiKey: "test-key", fetchImpl })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      tool_choice: { type: string; name: string }
      tools: Array<{ name: string; input_schema: { required: string[] } }>
    }
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_risk_verdict" })
    expect(body.tools[0].name).toBe("record_risk_verdict")
    expect(body.tools[0].input_schema.required).toEqual(["txHash", "score", "label", "reasons", "recommended_action"])
  })

  it("resolves to undefined (without calling fetch) when no API key is configured", async function () {
    const fetchImpl = vi.fn(async () => claudeResponse(VALID_INPUT))
    const verdict = await reasonAboutTx(INPUT, { apiKey: "", fetchImpl })
    expect(verdict).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("falls back to undefined on a non-2xx response", async function () {
    const fetchImpl = vi.fn(async () => claudeResponse({ error: "boom" }, 500))
    expect(await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl })).toBeUndefined()
  })

  it("falls back to undefined when the model output fails schema validation", async function () {
    const fetchImpl = vi.fn(async () => claudeResponse({ ...VALID_INPUT, label: "sketchy" }))
    expect(await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl })).toBeUndefined()
  })

  it("falls back to undefined when the response carries no tool_use block", async function () {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "no tool here" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    expect(await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl })).toBeUndefined()
  })

  it("falls back to undefined on a malformed JSON body", async function () {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>bad gateway</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    expect(await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl })).toBeUndefined()
  })

  it("falls back to undefined on a network error", async function () {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused")
    })
    expect(await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl })).toBeUndefined()
  })

  it("falls back to undefined on timeout via AbortController", async function () {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    const verdict = await reasonAboutTx(INPUT, { apiKey: "k", fetchImpl, timeoutMs: 25 })
    expect(verdict).toBeUndefined()
  })

  it("never rejects: every failure mode resolves", async function () {
    const failing = vi.fn(async () => {
      throw new Error("everything is on fire")
    })
    const results = await Promise.all([
      reasonAboutTx(INPUT, { apiKey: "k", fetchImpl: failing }),
      reasonAboutTx(INPUT, { apiKey: "", fetchImpl: failing }),
      reasonAboutTx(INPUT, { apiKey: "k", fetchImpl: failing, timeoutMs: 1 }),
    ])
    expect(results).toEqual([undefined, undefined, undefined])
  })
})
