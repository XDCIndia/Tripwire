import { describe, expect, it } from "vitest"

import { compilePolicy, compilePolicyFromJson, PolicyCompileError } from "../src/policyCompiler.js"

/** The issue's own worked example. */
const CANONICAL_POLICY = `Allow payments below $500 to previously used addresses.
Delay everything else for 1 hour.
Freeze transactions above $10,000.`

describe("compilePolicy", function () {
  it("compiles the issue's canonical example into the resolved rule table", function () {
    const policy = compilePolicy(CANONICAL_POLICY)
    expect(policy.version).toBe(1)
    expect(policy.source).toBe(CANONICAL_POLICY)

    // Author order is kept for specific rules; the catch-all goes last.
    expect(policy.rules).toHaveLength(3)
    expect(policy.rules[0]).toMatchObject({
      action: "ALLOW",
      fallback: false,
      amount: { comparison: "<", value: "500", currency: "USD" },
      recipient: "known",
    })
    expect(policy.rules[1]).toMatchObject({
      action: "FREEZE",
      fallback: false,
      amount: { comparison: ">", value: "10000", currency: "USD" },
      recipient: null,
    })
    expect(policy.rules[2]).toMatchObject({
      action: "DELAY",
      fallback: true,
      amount: null,
      recipient: null,
      delaySeconds: 60 * 60,
    })
  })

  it("understands several amount phrasings and durations", function () {
    const policy = compilePolicy(
      "Allow transfers up to 500 XDC to known addresses. Delay all other transactions for 30 minutes. Freeze anything over $1,000.",
    )
    expect(policy.rules[0].amount).toMatchObject({ comparison: "<=", value: "500", currency: "XDC" })
    // Specific rules keep author order; the catch-all delay sorts last.
    expect(policy.rules[1].amount).toMatchObject({ comparison: ">", value: "1000", currency: "USD" })
    expect(policy.rules[1].fallback).toBe(false)
    expect(policy.rules[2]).toMatchObject({ action: "DELAY", fallback: true, delaySeconds: 30 * 60 })
  })

  it("supports a single sentence with 'and' between rules", function () {
    const policy = compilePolicy("Allow payments below 100 XDC to known recipients and delay everything else for 2 hours")
    expect(policy.rules).toHaveLength(2)
    expect(policy.rules[1]).toMatchObject({ action: "DELAY", fallback: true, delaySeconds: 2 * 60 * 60 })
  })

  it("always places catch-all rules last, regardless of author order", function () {
    // Written delay-first: freezing over $10k must still beat the catch-all.
    const policy = compilePolicy("Delay everything else for 1 hour. Freeze transactions above $10,000.")
    expect(policy.rules.map((rule) => rule.action)).toEqual(["FREEZE", "DELAY"])
    expect(policy.rules[1].fallback).toBe(true)
  })

  it("keeps wei amounts untouched for the resolver", function () {
    const policy = compilePolicy("Freeze transactions above 1000000000000000000 wei.")
    expect(policy.rules[0].amount).toMatchObject({ comparison: ">", value: "1000000000000000000", currency: "WEI" })
  })

  it("rejects an empty or whitespace-only policy", function () {
    expect(() => compilePolicy("   ")).toThrowError(PolicyCompileError)
  })

  it("rejects sentences that do not start with a supported verb", function () {
    expect(() => compilePolicy("Send $500 to anyone.")).toThrowError(/every rule must start with one of/)
  })

  it("rejects an unconditional allow as fail-open", function () {
    expect(() => compilePolicy("Allow everything.")).toThrowError(/fail open/)
    expect(() => compilePolicy("Allow all transactions.")).toThrowError(/fail open/)
  })

  it("rejects a delay without a stated length", function () {
    expect(() => compilePolicy("Delay transactions to unknown addresses.")).toThrowError(/delay needs a length/)
  })

  it("rejects a duration on a non-delay rule", function () {
    expect(() => compilePolicy("Freeze transactions above $100 for 1 hour.")).toThrowError(/only "delay" rules take a duration/)
  })

  it("rejects leftover words it cannot map onto the policy model", function () {
    expect(() => compilePolicy("Allow payments below $500 to previously used addresses please.")).toThrowError(
      /Could not understand "please"/,
    )
  })

  it("rejects nonsense amount values", function () {
    expect(() => compilePolicy("Allow payments below $0 to known addresses.")).toThrowError(/amount must be greater than zero/)
  })
})

describe("compilePolicyFromJson", function () {
  it("accepts the canonical policy expressed as machine-readable JSON", function () {
    const policy = compilePolicyFromJson({
      version: 1,
      rules: [
        { action: "ALLOW", amount: { comparison: "<", value: "500", currency: "USD" }, recipient: "known" },
        { action: "DELAY", fallback: true, delaySeconds: 3600 },
        { action: "FREEZE", amount: { comparison: ">", value: "10000", currency: "USD" } },
      ],
    })
    expect(policy.rules.map((rule) => rule.action)).toEqual(["ALLOW", "FREEZE", "DELAY"])
    expect(policy.rules[2].fallback).toBe(true)
  })

  it("defaults an omitted amount comparison to below and currency to native", function () {
    const policy = compilePolicyFromJson({
      version: 1,
      rules: [{ action: "ALLOW", amount: { value: 100 }, recipient: "known" }],
    })
    expect(policy.rules[0].amount).toMatchObject({ comparison: "<", value: "100", currency: "XDC" })
  })

  it("lets the caller supply the natural-language source for previews", function () {
    const policy = compilePolicyFromJson({
      version: 1,
      source: "Allow payments below $500 to previously used addresses.",
      rules: [{ action: "ALLOW", amount: { comparison: "<", value: "500", currency: "USD" }, recipient: "known" }],
    })
    expect(policy.source).toBe("Allow payments below $500 to previously used addresses.")
  })

  it("rejects unknown top-level and rule keys with the exact path", function () {
    expect(() =>
      compilePolicyFromJson({
        version: 1,
        description: "an LLM added a field",
        rules: [{ action: "ALLOW", amount: { value: 500, currency: "USD", rationale: "low risk" } }],
      }),
    ).toThrowError(/unknown top-level key "description"/)
    expect(() => compilePolicyFromJson({ version: 1, rules: [{ action: "ALLOW", extras: true }] })).toThrowError(
      /unknown key "rules\[0\]\.extras"/,
    )
  })

  it("rejects wrong types, bad enums and invalid amounts with precise paths", function () {
    expect(() => compilePolicyFromJson({ version: 1, rules: [{ action: "MAYBE" }] })).toThrowError(
      /rules\[0\]\.action must be one of ALLOW, DELAY, FREEZE/,
    )
    expect(() =>
      compilePolicyFromJson({ version: 1, rules: [{ action: "ALLOW", amount: { comparison: "~", value: 5 } }] }),
    ).toThrowError(/comparison must be one of/)
    expect(() => compilePolicyFromJson({ version: 1, rules: [{ action: "ALLOW", amount: { value: -5 } }] })).toThrowError(
      /amount must be greater than zero/,
    )
    expect(() =>
      compilePolicyFromJson({ version: 1, rules: [{ action: "FREEZE", amount: { value: 100 }, delaySeconds: 60 }] }),
    ).toThrowError(/only delay rules may set delaySeconds/)
  })

  it("rejects semantic conflicts: duplicate rules and disagreeing catch-alls", function () {
    expect(() =>
      compilePolicyFromJson({
        version: 1,
        rules: [
          { action: "FREEZE", amount: { comparison: ">", value: "10000", currency: "USD" } },
          { action: "FREEZE", amount: { comparison: ">", value: "10000", currency: "USD" } },
        ],
      }),
    ).toThrowError(/duplicates rule 1 exactly/)
    expect(() =>
      compilePolicyFromJson({
        version: 1,
        rules: [{ action: "DELAY", fallback: true, delaySeconds: 3600 }, { action: "FREEZE", fallback: true }],
      }),
    ).toThrowError(/catch-all rules/)
  })

  it("rejects a fail-open JSON policy the same way it rejects one written in English", function () {
    expect(() =>
      compilePolicyFromJson({
        version: 1,
        rules: [{ action: "ALLOW", fallback: true }],
      }),
    ).toThrowError(/fail open/)
  })

  it("rejects non-objects, wrong versions and non-array rules", function () {
    expect(() => compilePolicyFromJson(null)).toThrowError(/must be a JSON object/)
    expect(() => compilePolicyFromJson({ version: 2, rules: [] })).toThrowError(/unsupported policy version 2/)
    expect(() => compilePolicyFromJson({ version: 1, rules: "nope" })).toThrowError(/rules must be an array/)
  })
})
