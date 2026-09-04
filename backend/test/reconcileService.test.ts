import { describe, expect, it } from "vitest"

import { type GuardSnapshot, expectedEnforcementOf } from "../src/reconcileEngine.js"
import type { ReconcileChainReader } from "../src/reconcileService.js"
import { ReconciliationError, ReconciliationService } from "../src/reconcileService.js"
import { createInMemoryReconcileStore } from "../src/reconcileStore.js"
import type { ChainStateSnapshot, RegistryVerdictState } from "../src/reconcileTypes.js"
import { RiskStatus, type RiskStatusValue } from "../src/verdict.js"

const START = 1_700_000_000_000

function verdictOf(status: RiskStatusValue): RegistryVerdictState {
  return { status, score: 90, releaseAt: 0 }
}

function guardOf(overrides: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n, ...overrides }
}

function chainOf(registry: RegistryVerdictState | null, guard: GuardSnapshot = guardOf()): ChainStateSnapshot {
  return { registryVerdict: registry, guard, execution: { kind: "none" } }
}

/** A chain reader whose state the test rewrites between checks. */
function scriptedReader(
  initial: () => ChainStateSnapshot,
): { reader: ReconcileChainReader; set: (state: ChainStateSnapshot) => void } {
  let state = initial()
  return {
    reader: {
      async readState(safeTxHash) {
        return { ...state, registryVerdict: state.registryVerdict ? { ...state.registryVerdict } : null }
      },
    },
    set(next) {
      state = next
    },
  }
}

function makeService(options: {
  reader: ReconcileChainReader
  alerts?: ReconciliationAlertSink
  recheckDelayMs?: number
  maxRechecks?: number
}) {
  return new ReconciliationService(createInMemoryReconcileStore(), {
    reader: options.reader,
    now: () => NOW,
    recheckDelayMs: options.recheckDelayMs,
    maxRechecks: options.maxRechecks,
    onAlert: options.alerts?.push,
  })
}

type ReconciliationAlertSink = {
  push(alert: unknown): void
}

let NOW = START

describe("ReconciliationService - recording", function () {
  it("records a verdict with its expected enforcement derived from the Guard snapshot", function () {
    NOW = START
    const { reader } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    const record = service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf({ perTxLimit: 500n }),
    })
    expect(record.expected).toEqual(
      expectedEnforcementOf(verdictOf(RiskStatus.HIGH_RISK), {
        value: 1_000n,
        now: NOW,
        guard: guardOf({ perTxLimit: 500n }),
      }),
    )
    expect(service.getRecord("0xabc")).toBeDefined()
    expect(record.mismatchAt).toBeNull()
  })

  it("refuses to re-register the same transaction - expectations must never silently change", function () {
    NOW = START
    const { reader } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })
    expect(() =>
      service.recordEnforcement({
        safeTxHash: "0xabc",
        verdictAtSubmit: verdictOf(RiskStatus.LOW_RISK),
        value: 1_000n,
        guardAtSubmit: guardOf(),
      }),
    ).toThrow(ReconciliationError)
  })

  it("refuses a check for a transaction that was never recorded", async function () {
    NOW = START
    const { reader } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    await expect(service.check("0xnever")).rejects.toThrow(/record it first/)
  })
})

describe("ReconciliationService - checking and alerts", function () {
  it("reports MATCH when the on-chain state agrees with the expectation", async function () {
    NOW = START
    const { reader } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })
    const { record, result } = await service.check("0xabc")
    expect(result.status).toBe("MATCH")
    expect(result.critical).toBe(false)
    expect(record.latest?.status).toBe("MATCH")
    expect(record.mismatchAt).toBeNull()
    expect(service.historyOf("0xabc").map((event) => event.kind)).toEqual(["recorded", "checked"])
  })

  it("raises a critical alert when protection quietly stopped (registry rewritten)", async function () {
    NOW = START
    const { reader, set } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const alerts: unknown[] = []
    const service = makeService({ reader, alerts: { push: (alert) => alerts.push(alert) } })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })

    // Between submit and check, the registry verdict was rewritten to LOW_RISK.
    set(chainOf(verdictOf(RiskStatus.LOW_RISK)))
    const { result } = await service.check("0xabc")
    expect(result.status).toBe("MISMATCH")
    expect(result.critical).toBe(true)
    expect(alerts).toHaveLength(1)
    const alert = alerts[0] as { severity: string; kind: string; safeTxHash: string }
    expect(alert.severity).toBe("critical")
    expect(alert.kind).toBe("protection_not_active")
    expect(alert.safeTxHash).toBe("0xabc")
  })

  it("latches mismatchAt forever, even after a later healthy check", async function () {
    NOW = START
    const { reader, set } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })

    set(chainOf(verdictOf(RiskStatus.LOW_RISK)))
    await service.check("0xabc")
    expect(service.getRecord("0xabc")?.mismatchAt).toBe(NOW)

    // The owner restores the verdict; a re-check now observes recovery...
    NOW += 60_000
    set(chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const { result } = await service.check("0xabc")
    expect(result.status).toBe("MATCH")
    // ...but the incident latch never clears - recovery is history, not erasure.
    expect(service.getRecord("0xabc")?.mismatchAt).toBe(START)
    expect(service.getRecord("0xabc")?.latest?.status).toBe("MATCH")
    expect(service.historyOf("0xabc")).toHaveLength(3)
  })

  it("keeps a guard freeze blocking as MATCH even if the verdict was rewritten", async function () {
    NOW = START
    const { reader, set } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const alerts: unknown[] = []
    const service = makeService({ reader, alerts: { push: (alert) => alerts.push(alert) } })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })
    set(chainOf(verdictOf(RiskStatus.LOW_RISK), guardOf({ frozen: true })))
    const { result } = await service.check("0xabc")
    expect(result.status).toBe("MATCH")
    expect(alerts).toHaveLength(0)
  })
})

describe("ReconciliationService - automatic re-checks", function () {
  it("re-checks PENDING outcomes on the configured cadence", async function () {
    NOW = START
    const states = new Map<string, ChainStateSnapshot>()
    const reader: ReconcileChainReader = {
      async readState(safeTxHash) {
        return states.get(safeTxHash)!
      },
    }
    // No execution attempt observed: an ALLOW stays PENDING until it executes.
    states.set("0xabc", chainOf(verdictOf(RiskStatus.LOW_RISK)))
    const service = makeService({ reader, recheckDelayMs: 10_000 })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.LOW_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })

    expect(service.dueRecords(NOW).map((record) => record.safeTxHash)).toEqual(["0xabc"])
    await service.runDueCycle(NOW)
    expect(service.getRecord("0xabc")?.latest?.status).toBe("PENDING")
    expect(service.dueRecords(NOW)).toHaveLength(0) // not due yet

    NOW += 10_001
    expect(service.dueRecords(NOW).map((record) => record.safeTxHash)).toEqual(["0xabc"])
    await service.runDueCycle(NOW)
    expect(service.getRecord("0xabc")?.rechecks).toBe(2)
  })

  it("stops automatically re-checking after maxRechecks - the PENDING record stays visible", async function () {
    NOW = START
    const { reader } = scriptedReader(() => chainOf(verdictOf(RiskStatus.LOW_RISK)))
    const service = makeService({ reader, recheckDelayMs: 10, maxRechecks: 3 })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.LOW_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })

    for (let cycle = 1; cycle <= 3; cycle++) {
      NOW += 11
      await service.runDueCycle(NOW)
      expect(service.getRecord("0xabc")?.rechecks).toBe(cycle)
    }
    NOW += 11
    const outcome = await service.runDueCycle(NOW)
    expect(outcome.checked).toHaveLength(0)
    // Ceiling reached, but the record is still queryable - never dropped.
    expect(service.getRecord("0xabc")?.latest?.status).toBe("PENDING")
  })

  it("returns alerts from runDueCycle for critical outcomes", async function () {
    NOW = START
    const { reader, set } = scriptedReader(() => chainOf(verdictOf(RiskStatus.HIGH_RISK)))
    const service = makeService({ reader })
    service.recordEnforcement({
      safeTxHash: "0xabc",
      verdictAtSubmit: verdictOf(RiskStatus.HIGH_RISK),
      value: 1_000n,
      guardAtSubmit: guardOf(),
    })
    set(chainOf(verdictOf(RiskStatus.LOW_RISK)))
    const { alerts } = await service.runDueCycle(NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("protection_not_active")
  })
})
