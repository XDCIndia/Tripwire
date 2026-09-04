import { describe, expect, it } from "vitest"

import { type CompiledPolicy } from "../src/policyTypes.js"
import { validatePolicy } from "../src/policyValidator.js"

function policyWithRules(rules: CompiledPolicy["rules"]): CompiledPolicy {
  return { version: 1, source: "test", rules }
}

function baseRule(overrides: Partial<CompiledPolicy["rules"][number]> = {}): CompiledPolicy["rules"][number] {
  return {
    action: "ALLOW",
    amount: { comparison: "<", value: "500", currency: "USD", source: "$500" },
    recipient: "known",
    delaySeconds: null,
    fallback: false,
    source: "allow",
    ...overrides,
  }
}

/** Asserts some reported issue mentions `substring` (issues are full
 * sentences prefixed with "rule N:", so plain `toContain` on the array
 * would demand an exact whole-element match). */
function expectIssue(rules: CompiledPolicy["rules"], substring: string): void {
  const issues = validatePolicy(policyWithRules(rules))
  expect(issues).not.toEqual([])
  expect(issues.some((issue) => issue.includes(substring))).toBe(true)
}

describe("validatePolicy", function () {
  it("accepts a well-formed policy with no issues", function () {
    expect(validatePolicy(policyWithRules([baseRule()]))).toEqual([])
  })

  it("rejects an empty policy", function () {
    expectIssue([], "policy has no rules")
  })

  it("rejects zero and negative amounts", function () {
    expectIssue([baseRule({ amount: { comparison: "<", value: "0", currency: "USD", source: "$0" } })], 'amount must be greater than zero (got "0")')
    expectIssue([baseRule({ amount: { comparison: "<", value: "-5", currency: "USD", source: "-$5" } })], 'amount must be greater than zero (got "-5")')
  })

  it("rejects amounts that are not plain positive decimals", function () {
    expectIssue(
      [baseRule({ amount: { comparison: "<", value: "5 dollars and change", currency: "USD", source: "x" } })],
      'amount "5 dollars and change" is not a positive number',
    )
  })

  it("rejects absurdly long amounts", function () {
    expectIssue(
      [baseRule({ amount: { comparison: ">", value: "9".repeat(70), currency: "WEI", source: "x" } })],
      "has too many digits",
    )
  })

  it("requires a delay rule to carry a valid delaySeconds", function () {
    expectIssue(
      [baseRule({ action: "DELAY", fallback: true, amount: null, recipient: null, delaySeconds: null })],
      "a delay rule must set delaySeconds",
    )

    expectIssue(
      [
        baseRule({
          action: "DELAY",
          fallback: true,
          amount: null,
          recipient: null,
          delaySeconds: 40 * 24 * 60 * 60,
        }),
      ],
      "delaySeconds must be an integer",
    )
  })

  it("rejects a duration on rules that are not delays", function () {
    expectIssue(
      [
        baseRule({
          action: "FREEZE",
          amount: { comparison: ">", value: "100", currency: "USD", source: "$100" },
          delaySeconds: 3600,
        }),
      ],
      "only delay rules may set delaySeconds",
    )
  })

  it("rejects an unconditional allow and an unconditional non-catch-all rule", function () {
    expectIssue([baseRule({ action: "ALLOW", amount: null, recipient: null, fallback: true })], "fail open")
    expectIssue([baseRule({ action: "FREEZE", amount: null, recipient: null, fallback: false })], "must carry an amount limit")
  })

  it("rejects a catch-all that carries conditions", function () {
    expectIssue(
      [baseRule({ action: "DELAY", recipient: "known", fallback: true, delaySeconds: 60 })],
      "a catch-all rule must not carry conditions",
    )
  })

  it("rejects exact duplicate rules", function () {
    expectIssue([baseRule(), baseRule()], "duplicates rule 1 exactly")
  })

  it("rejects two catch-all rules", function () {
    expectIssue(
      [
        baseRule({ action: "DELAY", amount: null, recipient: null, fallback: true, delaySeconds: 60 }),
        baseRule({ action: "FREEZE", amount: null, recipient: null, fallback: true }),
      ],
      "catch-all rules",
    )
  })

  it("accepts distinct rules that overlap in scope (fail-closed ordering resolves them)", function () {
    // Same shape as the canonical example: an allow carve-out plus a catch-all.
    const rules = [
      baseRule(),
      baseRule({ action: "DELAY", amount: null, recipient: null, fallback: true, delaySeconds: 3600 }),
    ]
    expect(validatePolicy(policyWithRules(rules))).toEqual([])
  })
})
