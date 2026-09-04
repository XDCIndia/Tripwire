import { describe, expect, it } from "vitest"

import { expectedEnforcementOf, reconcile, type GuardSnapshot } from "../src/reconcileEngine.js"
import type { ChainStateSnapshot, ExecutionObservation, RegistryVerdictState } from "../src/reconcileTypes.js"
import { RiskStatus, type RiskStatusValue } from "../src/verdict.js"

/** Epoch ms used everywhere in these tests. */
const NOW = 1_700_000_000_000
/** A transaction value comfortably inside every limit used here. */
const VALUE = 1_000n
/** releaseAt in *registry seconds*, as read from the chain. */
const RELEASE_AT_S = 1_700_003_600

function verdictOf(status: RiskStatusValue, releaseAt = 0): RegistryVerdictState {
  return { status, score: 50, releaseAt }
}

function guardOf(overrides: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n, ...overrides }
}

function chainOf(
  registry: RegistryVerdictState | null,
  guard: GuardSnapshot,
  execution: ExecutionObservation = { kind: "none" },
): ChainStateSnapshot {
  return { registryVerdict: registry, guard, execution }
}

describe("expectedEnforcementOf", function () {
  it("blocks everything when the guard freeze switch is on, over any verdict", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), {
      value: VALUE,
      now: NOW,
      guard: guardOf({ frozen: true }),
    })
    expect(expected).toMatchObject({ action: "BLOCK", reason: "guard freeze switch is on", freezeExpected: true })
  })

  it("treats a FROZEN registry verdict as a block even when the switch is off", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.FROZEN), { value: VALUE, now: NOW, guard: guardOf() })
    expect(expected).toMatchObject({ action: "BLOCK", reason: "registry verdict is FROZEN" })
  })

  it("blocks HIGH_RISK verdicts outright", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), {
      value: VALUE,
      now: NOW,
      guard: guardOf(),
    })
    expect(expected).toMatchObject({ action: "BLOCK", reason: "verdict is HIGH_RISK" })
  })

  it("fails closed on UNSCORED - no verdict means blocked, never allowed", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.UNSCORED), { value: VALUE, now: NOW, guard: guardOf() })
    expect(expected).toMatchObject({ action: "BLOCK", reason: "no verdict recorded (fail closed)" })
  })

  it("delays a DELAYED verdict whose releaseAt is still in the future", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), {
      value: VALUE,
      now: NOW,
      guard: guardOf(),
    })
    expect(expected).toMatchObject({ action: "DELAY", verdictStatus: RiskStatus.DELAYED })
    // releaseAt crosses from registry seconds to epoch ms at this boundary.
    expect(expected.releaseAt).toBe(RELEASE_AT_S * 1000)
  })

  it("allows a DELAYED verdict whose window has passed", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.DELAYED, 1), {
      value: VALUE,
      now: NOW,
      guard: guardOf(),
    })
    expect(expected.action).toBe("ALLOW")
    expect(expected.reason).toContain("delay window has passed")
  })

  it("allows LOW_RISK value inside the spending limits", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), {
      value: VALUE,
      now: NOW,
      guard: guardOf({ perTxLimit: 10_000n }),
    })
    expect(expected).toMatchObject({ action: "ALLOW", reason: "verdict is LOW_RISK" })
  })

  it("blocks a LOW_RISK verdict when the value breaches perTxLimit - limits are a hard backstop", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), {
      value: 20_000n,
      now: NOW,
      guard: guardOf({ perTxLimit: 10_000n }),
    })
    expect(expected).toMatchObject({ action: "BLOCK" })
    expect(expected.reason).toContain("per-tx limit")
  })

  it("blocks when the value would breach the rolling 24h limit", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), {
      value: 6_000n,
      now: NOW,
      guard: guardOf({ rollingLimit: 10_000n, windowSpent: 5_000n }),
    })
    expect(expected).toMatchObject({ action: "BLOCK" })
    expect(expected.reason).toContain("rolling 24h limit")
  })
})

describe("reconcile - execution observations win over inference", function () {
  it("is MISMATCH (critical) when a transaction expected to be blocked executed anyway", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf(), { kind: "success" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MISMATCH")
    expect(result.critical).toBe(true)
    expect(result.notes[0]).toContain("should have been blocked")
  })

  it("is MISMATCH when a DELAYED transaction executes before its window expired", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), {
        value: VALUE,
        now: NOW,
        guard: guardOf(),
      }),
      current: chainOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), guardOf(), { kind: "success" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MISMATCH")
    expect(result.critical).toBe(true)
  })

  it("treats a reverted execution attempt under an expected block as REVERTED - enforcement held", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf(), { kind: "reverted" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("REVERTED")
    expect(result.critical).toBe(false)
    expect(result.notes[0]).toContain("block was enforced")
  })

  it("is REVERTED but notes when a revert had nothing to do with the verdict", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf(), { kind: "reverted" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("REVERTED")
    expect(result.notes[0]).toContain("not the cause")
  })

  it("is DROPPED when the enforcement transaction was dropped or replaced", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf(), { kind: "dropped", replacedBy: "0xabc" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("DROPPED")
    expect(result.notes[0]).toContain("replaced")
  })

  it("keeps an in-flight attempt PENDING with a recheck scheduled", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf(), { kind: "pending" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("PENDING")
    expect(result.recheckAt).not.toBeNull()
  })
})

describe("reconcile - expected BLOCK with no execution observed", function () {
  it("is MATCH when the protection is still active", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf()),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MATCH")
    expect(result.critical).toBe(false)
  })

  it("is MATCH when the block is held by the freeze switch", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf({ frozen: true })),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MATCH")
  })

  it("is MISMATCH (critical) when the registry verdict was rewritten and nothing else blocks", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf()),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MISMATCH")
    expect(result.critical).toBe(true)
    expect(result.notes.join(" ")).toContain("protection is not active")
  })

  it("is MISMATCH when only the spending limits were quietly raised", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), {
        value: 20_000n,
        now: NOW,
        guard: guardOf({ perTxLimit: 10_000n }),
      }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf({ perTxLimit: 50_000n })),
      value: 20_000n,
      now: NOW,
    })
    expect(result.status).toBe("MISMATCH")
    expect(result.critical).toBe(true)
  })
})

describe("reconcile - expected DELAY / ALLOW without execution", function () {
  it("keeps a live delay PENDING until its releaseAt", function () {
    const expected = expectedEnforcementOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), {
      value: VALUE,
      now: NOW,
      guard: guardOf(),
    })
    const result = reconcile({
      expected,
      current: chainOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), guardOf()),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("PENDING")
    expect(result.recheckAt).toBe(expected.releaseAt)
  })

  it("never confirms an ALLOW without execution - absence of a tx proves nothing", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf()),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("PENDING")
    expect(result.recheckAt).not.toBeNull()
  })

  it("is MATCH once an allowed transaction actually executed", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf(), { kind: "success" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MATCH")
    expect(result.critical).toBe(false)
  })

  it("is MATCH when a delayed transaction executes after its window passed", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), {
        value: VALUE,
        now: NOW,
        guard: guardOf(),
      }),
      current: chainOf(verdictOf(RiskStatus.DELAYED, RELEASE_AT_S), guardOf(), { kind: "success" }),
      value: VALUE,
      now: RELEASE_AT_S * 1000 + 5,
    })
    expect(result.status).toBe("MATCH")
  })

  it("flags drift when an allowed transaction executed but the chain now blocks it", function () {
    const result = reconcile({
      expected: expectedEnforcementOf(verdictOf(RiskStatus.LOW_RISK), { value: VALUE, now: NOW, guard: guardOf() }),
      current: chainOf(verdictOf(RiskStatus.HIGH_RISK), guardOf(), { kind: "success" }),
      value: VALUE,
      now: NOW,
    })
    expect(result.status).toBe("MISMATCH")
  })
})
