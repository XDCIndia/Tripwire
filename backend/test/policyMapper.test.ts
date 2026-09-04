import { describe, expect, it } from "vitest"

import { compilePolicy, compilePolicyFromJson } from "../src/policyCompiler.js"
import { explainPolicy, evaluatePolicy, renderDuration, renderRule, resolvePolicy, verdictForEvaluation, PolicyResolveError } from "../src/policyMapper.js"
import { RiskStatus } from "../src/verdict.js"

/** The issue's canonical policy, resolved at the demo rate 1 USD = 1 XDC. */
const CANONICAL_POLICY = `Allow payments below $500 to previously used addresses.
Delay everything else for 1 hour.
Freeze transactions above $10,000.`

const WEI = 10n ** 18n
const FIVE_HUNDRED_WEI = 500n * WEI
const TEN_THOUSAND_WEI = 10_000n * WEI

function resolvedCanonical() {
  const policy = compilePolicy(CANONICAL_POLICY)
  return resolvePolicy(policy, { usdPerNative: "1" })
}

describe("explainPolicy", function () {
  it("renders a numbered, human-readable preview of the compiled policy", function () {
    const text = explainPolicy(compilePolicy(CANONICAL_POLICY))
    expect(text).toContain("3 rules")
    expect(text).toContain("Allow transactions below $500 to previously used recipients.")
    expect(text).toContain("Delay everything else for 1 hour.")
    expect(text).toContain("Freeze transactions above $10,000.")
    expect(text).toContain("fail closed")
  })

  it("renders durations in the friendliest whole unit", function () {
    expect(renderDuration(3600)).toBe("1 hour")
    expect(renderDuration(1800)).toBe("30 minutes")
    expect(renderDuration(2 * 24 * 60 * 60)).toBe("2 days")
    expect(renderDuration(90)).toBe("90 seconds")
  })
})

describe("resolvePolicy", function () {
  it("resolves native-token amounts to wei using the asset's decimals", function () {
    const policy = compilePolicy("Freeze transactions above 1.5 XDC. Delay all transactions over 0.5 XDC for 1 hour.")
    const resolved = resolvePolicy(policy)
    expect(resolved.rules[0].amount?.wei).toBe(15n * WEI / 10n)
    expect(resolved.rules[1].amount?.wei).toBe(5n * WEI / 10n)
  })

  it("resolves wei amounts unchanged", function () {
    const policy = compilePolicy("Freeze transactions above 12345 wei.")
    expect(resolvePolicy(policy).rules[0].amount?.wei).toBe(12345n)
  })

  it("resolves USD amounts only when an explicit rate is provided - never silently", function () {
    const policy = compilePolicy(CANONICAL_POLICY)
    expect(() => resolvePolicy(policy)).toThrowError(PolicyResolveError)
    expect(() => resolvePolicy(policy)).toThrowError(/rule 1 uses a USD amount.*usdPerNative/s)

    const resolved = resolvePolicy(policy, { usdPerNative: "1" })
    expect(resolved.rules[0].amount?.wei).toBe(FIVE_HUNDRED_WEI)
    expect(resolved.rules[1].amount?.wei).toBe(TEN_THOUSAND_WEI)
  })

  it("applies the rate in the right direction", function () {
    // 1 native token = $0.5, so $1,000 must resolve to 2,000 native tokens.
    const policy = compilePolicy("Freeze transactions above $1,000.")
    const resolved = resolvePolicy(policy, { usdPerNative: "0.5" })
    expect(resolved.rules[0].amount?.wei).toBe(2_000n * WEI)
  })

  it("rejects a malformed rate and malformed native decimals", function () {
    const policy = compilePolicy("Freeze transactions above $1,000.")
    expect(() => resolvePolicy(policy, { usdPerNative: "free" })).toThrowError(/usdPerNative must be a positive decimal/)
    expect(() => resolvePolicy(policy, { usdPerNative: "0" })).toThrowError(/usdPerNative must be a positive decimal/)
    expect(() => resolvePolicy(policy, { nativeDecimals: 100, usdPerNative: "1" })).toThrowError(/nativeDecimals/)
  })
})

describe("guardConfigOf", function () {
  it("derives perTxLimit from the policy's freeze floors", function () {
    const { guardConfig } = resolvedCanonical()
    expect(guardConfig.perTxLimit).toBe(TEN_THOUSAND_WEI)
    expect(guardConfig.rollingLimit).toBe(0n)
  })

  it("uses the most protective floor when several freeze bands exist", function () {
    const policy = compilePolicy("Freeze transactions above $100,000. Freeze transactions above $1,000.")
    const { guardConfig } = resolvePolicy(policy, { usdPerNative: "1" })
    expect(guardConfig.perTxLimit).toBe(1_000n * WEI)
  })

  it("leaves the limit disabled when the policy never freezes on an amount", function () {
    const policy = compilePolicy("Allow payments below $500 to known addresses. Delay everything else for 1 hour.")
    const { guardConfig } = resolvePolicy(policy, { usdPerNative: "1" })
    expect(guardConfig.perTxLimit).toBe(0n)
    expect(guardConfig.defaultDelaySeconds).toBe(3600)
  })

  it("never derives a perTxLimit from delay rules", function () {
    const policy = compilePolicy("Delay transactions above $1,000 for 1 hour. Allow payments below $500 to known addresses.")
    const { guardConfig } = resolvePolicy(policy, { usdPerNative: "1" })
    expect(guardConfig.perTxLimit).toBe(0n)
  })
})

describe("evaluateResolvedPolicy", function () {
  it("reproduces the issue's worked example exactly", function () {
    const resolved = resolvedCanonical()
    const now = 1_700_000_000

    const smallKnown = evaluatePolicy(compilePolicy(CANONICAL_POLICY), { value: 300n * WEI, recipientKnown: true }, { usdPerNative: "1" }, now)
    expect(smallKnown.action).toBe("ALLOW")

    const smallUnknown = evaluatePolicy(compilePolicy(CANONICAL_POLICY), { value: 300n * WEI, recipientKnown: false }, { usdPerNative: "1" }, now)
    expect(smallUnknown.action).toBe("DELAY")
    expect(smallUnknown.releaseAt).toBe(now + 3600)

    const hugeKnown = evaluatePolicy(compilePolicy(CANONICAL_POLICY), { value: 20_000n * WEI, recipientKnown: true }, { usdPerNative: "1" }, now)
    expect(hugeKnown.action).toBe("FREEZE")

    const midKnown = evaluatePolicy(compilePolicy(CANONICAL_POLICY), { value: 700n * WEI, recipientKnown: true }, { usdPerNative: "1" }, now)
    expect(midKnown.action).toBe("DELAY")

    expect(resolved.rules).toHaveLength(3)
  })

  it("resolves in author order for specific rules and lets the catch-all take the rest", function () {
    const policy = compilePolicy("Freeze transactions above $10,000. Allow payments below $500 to known addresses. Delay everything else for 1 hour.")
    const ctx = { usdPerNative: "1" }
    expect(evaluatePolicy(policy, { value: 20_000n * WEI, recipientKnown: true }, ctx).action).toBe("FREEZE")
    expect(evaluatePolicy(policy, { value: 100n * WEI, recipientKnown: true }, ctx).action).toBe("ALLOW")
    expect(evaluatePolicy(policy, { value: 100n * WEI, recipientKnown: false }, ctx).action).toBe("DELAY")
  })

  it("fails closed (FREEZE) when no rule matches and no catch-all exists", function () {
    const policy = compilePolicy("Allow payments below $500 to known addresses.")
    const result = evaluatePolicy(policy, { value: 100n * WEI, recipientKnown: false }, { usdPerNative: "1" })
    expect(result.action).toBe("FREEZE")
    expect(result.matched).toBeNull()
    expect(result.releaseAt).toBeNull()
  })

  it("can evaluate a policy compiled from machine JSON identically", function () {
    const fromJson = compilePolicyFromJson({
      version: 1,
      rules: [
        { action: "ALLOW", amount: { comparison: "<", value: "500", currency: "USD" }, recipient: "known" },
        { action: "DELAY", fallback: true, delaySeconds: 3600 },
        { action: "FREEZE", amount: { comparison: ">", value: "10000", currency: "USD" } },
      ],
    })
    const ctx = { usdPerNative: "1" }
    expect(evaluatePolicy(fromJson, { value: 300n * WEI, recipientKnown: true }, ctx).action).toBe("ALLOW")
    expect(evaluatePolicy(fromJson, { value: 20_000n * WEI, recipientKnown: false }, ctx).action).toBe("FREEZE")
  })
})

describe("verdictForEvaluation", function () {
  it("maps policy actions onto RiskRegistry verdicts", function () {
    expect(verdictForEvaluation({ action: "ALLOW", matched: null, releaseAt: null })).toMatchObject({
      status: RiskStatus.LOW_RISK,
      score: 0,
    })
    const delay = verdictForEvaluation({ action: "DELAY", matched: null, releaseAt: 1234 })
    expect(delay).toMatchObject({ status: RiskStatus.DELAYED, releaseAt: 1234 })
    expect(verdictForEvaluation({ action: "FREEZE", matched: null, releaseAt: null })).toMatchObject({
      status: RiskStatus.HIGH_RISK,
      score: 100,
    })
  })
})

describe("renderRule", function () {
  it("renders a recipient-only allow and an unknown-recipient rule", function () {
    const policy = compilePolicy("Allow payments to previously used addresses. Freeze transactions to unknown addresses.")
    expect(policy.rules[0].source).toBe("Allow payments to previously used addresses")
    expect(renderRule(policy.rules[0])).toBe("Allow transactions to previously used recipients.")
    expect(renderRule(policy.rules[1])).toBe("Freeze transactions to unknown recipients.")
  })
})
