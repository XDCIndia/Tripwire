/**
 * Reconciliation logic (issue #50): derive what enforcement *should* be, then
 * compare it against what the chain *actually* shows.
 *
 * Two pure functions, no I/O, exhaustively unit-tested:
 *
 *  - `expectedEnforcementOf` - what the Guard is supposed to do with a
 *    transaction, from a verdict + Guard config snapshot. Guard-level
 *    controls (freeze switch, spending limits) override verdict-level ones,
 *    exactly like TripwireGuard.sol enforces them: a LOW_RISK verdict still
 *    means BLOCK if the value is over `perTxLimit`, and a frozen Guard
 *    blocks everything.
 *
 *  - `reconcile` - the decision table. The invariant that makes this layer
 *    worth having: a blocked transaction that *executed*, or a protection
 *    that is no longer active, is always MISMATCH and always `critical` -
 *    never downgraded, never silently confirmed. The only route to MATCH is
 *    an observation that genuinely agrees with the expectation.
 *
 * Time units: everything on this side of the reader is epoch *milliseconds*;
 * verdict.releaseAt arrives from the chain in epoch *seconds* and is
 * converted at the boundary in `expectedEnforcementOf`.
 */

import {
  type ChainStateSnapshot,
  type ExpectedEnforcement,
  type ReconciliationResult,
  type ReconciliationStatus,
  type RegistryVerdictState,
  STATUS_NAMES,
} from "./reconcileTypes.js"
import { RiskStatus } from "./verdict.js"

/** Guard config read at the moment the expectation is formed. */
export interface GuardSnapshot {
  frozen: boolean
  perTxLimit: bigint
  rollingLimit: bigint
  windowSpent: bigint
}

export interface ExpectedEnforcementOptions {
  /** Transaction value in wei - needed for the Guard's spending limits. */
  value: bigint
  /** Epoch ms now, for delay expiry. */
  now: number
  guard: GuardSnapshot
}

/**
 * What the Guard should do with a transaction given its recorded verdict and
 * the Guard configuration - the "expected" side of every reconciliation.
 * Order of precedence mirrors TripwireGuard.checkTransaction: freeze switch,
 * then verdict (block/delay/allow), then spending limits as a backstop on
 * top of an allow.
 */
export function expectedEnforcementOf(
  verdict: RegistryVerdictState,
  options: ExpectedEnforcementOptions,
): ExpectedEnforcement {
  const frozen = options.guard.frozen || verdict.status === RiskStatus.FROZEN
  if (frozen) {
    return {
      action: "BLOCK",
      reason: verdict.status === RiskStatus.FROZEN ? "registry verdict is FROZEN" : "guard freeze switch is on",
      verdictStatus: verdict.status,
      releaseAt: 0,
      freezeExpected: true,
    }
  }

  if (verdict.status === RiskStatus.HIGH_RISK) {
    return {
      action: "BLOCK",
      reason: "verdict is HIGH_RISK",
      verdictStatus: verdict.status,
      releaseAt: 0,
      freezeExpected: false,
    }
  }

  if (verdict.status === RiskStatus.DELAYED) {
    const releaseAtMs = verdict.releaseAt * 1000
    if (options.now < releaseAtMs) {
      return {
        action: "DELAY",
        reason: `verdict is DELAYED until epoch ${verdict.releaseAt}`,
        verdictStatus: verdict.status,
        releaseAt: releaseAtMs,
        freezeExpected: false,
      }
    }
    return allowExpectation(verdict, options)
  }

  if (verdict.status === RiskStatus.UNSCORED) {
    // Nothing was ever scored. Fail-closed on-chain: no verdict = blocked.
    return {
      action: "BLOCK",
      reason: "no verdict recorded (fail closed)",
      verdictStatus: verdict.status,
      releaseAt: 0,
      freezeExpected: false,
    }
  }

  return allowExpectation(verdict, options)
}

function overLimits(value: bigint, guard: GuardSnapshot): { blocked: boolean; reason: string } {
  if (guard.perTxLimit > 0n && value > guard.perTxLimit) {
    return { blocked: true, reason: `value exceeds the guard's per-tx limit (${value} > ${guard.perTxLimit})` }
  }
  if (guard.rollingLimit > 0n && guard.windowSpent + value > guard.rollingLimit) {
    return { blocked: true, reason: "value would exceed the guard's rolling 24h limit" }
  }
  return { blocked: false, reason: "" }
}

function allowExpectation(verdict: RegistryVerdictState, options: ExpectedEnforcementOptions): ExpectedEnforcement {
  const limits = overLimits(options.value, options.guard)
  if (limits.blocked) {
    return {
      action: "BLOCK",
      reason: limits.reason,
      verdictStatus: verdict.status,
      releaseAt: 0,
      freezeExpected: false,
    }
  }
  return {
    action: "ALLOW",
    reason: verdict.status === RiskStatus.LOW_RISK ? "verdict is LOW_RISK" : "delay window has passed",
    verdictStatus: verdict.status,
    releaseAt: 0,
    freezeExpected: false,
  }
}

export interface ReconcileInput {
  expected: ExpectedEnforcement
  current: ChainStateSnapshot
  /** Transaction value in wei, for limit-aware checks of the current state. */
  value: bigint
  /** Epoch ms. */
  now: number
}

type Draft = Omit<ReconciliationResult, "status" | "critical">

function draft(input: ReconcileInput): Draft {
  const registry = input.current.registryVerdict
  return {
    expected: { action: input.expected.action, reason: input.expected.reason },
    actual: {
      registryStatus: registry?.status ?? null,
      registryStatusName: registry === null ? "none" : STATUS_NAMES[registry.status],
      guardFrozen: input.current.guard.frozen,
      executionKind: input.current.execution.kind,
    },
    notes: [],
    checkedAt: input.now,
    recheckAt: null,
  }
}

function settle(result: Draft, status: ReconciliationStatus): ReconciliationResult {
  // Only MISMATCH is ever critical; a failed/mismatched enforcement can
  // never be silently converted into a confirmed MATCH.
  return { ...result, status, critical: status === "MISMATCH" }
}

/** True if the Guard still stops this transaction right now. */
function protectionActive(input: ReconcileInput): { active: boolean; why: string } {
  const { current, value } = input
  if (current.guard.frozen) return { active: true, why: "guard freeze switch is on" }
  if (
    current.registryVerdict?.status === RiskStatus.HIGH_RISK ||
    current.registryVerdict?.status === RiskStatus.FROZEN
  ) {
    return { active: true, why: "registry verdict still blocks" }
  }
  const limits = overLimits(value, current.guard)
  if (limits.blocked) return { active: true, why: limits.reason }
  return { active: false, why: "verdict no longer blocks and the guard is not frozen" }
}

/**
 * Compares expected enforcement against the current on-chain snapshot and
 * returns one reconciliation status. Rules of thumb encoded here:
 *
 *  - an execution observation always wins over inference: a BLOCK that
 *    still executed is MISMATCH, a BLOCK attempt that reverted is REVERTED
 *    (enforcement held), a dropped/replaced tx is DROPPED;
 *  - registry drift is the attacker signal: expected BLOCK/DELAY while the
 *    chain no longer blocks is MISMATCH (protection no longer active);
 *  - anything unsettled is PENDING with a `recheckAt`, never assumed done.
 */
export function reconcile(input: ReconcileInput): ReconciliationResult {
  const result = draft(input)
  const { expected, current, now } = input
  const execution = current.execution

  if (execution.kind === "dropped") {
    result.notes.push(
      execution.replacedBy
        ? `transaction was replaced on-chain by ${execution.replacedBy}`
        : "transaction was dropped on-chain without executing",
    )
    return settle(result, "DROPPED")
  }

  if (execution.kind === "success") {
    if (expected.action === "BLOCK") {
      result.notes.push(
        "CRITICAL: a transaction that should have been blocked executed anyway - " +
          "the Guard did not stop it (was it detached?)",
      )
      return settle(result, "MISMATCH")
    }
    if (expected.action === "DELAY" && now < expected.releaseAt) {
      result.notes.push(
        `CRITICAL: transaction executed at ${now}, before the delay window expired at ${expected.releaseAt}`,
      )
      return settle(result, "MISMATCH")
    }
    if (!protectionActive(input).active) {
      result.notes.push("transaction executed as expected (allowed)")
      return settle(result, "MATCH")
    }
    result.notes.push("transaction executed, but the chain now blocks this transaction - state drifted")
    return settle(result, "MISMATCH")
  }

  if (execution.kind === "reverted") {
    result.notes.push(
      expected.action === "BLOCK"
        ? "execution attempt reverted - the block was enforced"
        : "execution attempt reverted (the verdict was not the cause)",
    )
    return settle(result, "REVERTED")
  }

  if (execution.kind === "pending") {
    result.notes.push("execution attempt is pending - outcome unresolved, re-checking later")
    result.recheckAt = now + 1 // the service applies its own recheck cadence
    return settle(result, "PENDING")
  }

  // No execution attempt observed at all.
  if (expected.action === "BLOCK") {
    const protection = protectionActive(input)
    if (!protection.active) {
      result.notes.push(`CRITICAL: expected protection is not active - ${protection.why}`)
      return settle(result, "MISMATCH")
    }
    result.notes.push(`expected block is active (${protection.why}) and no transaction has executed`)
    return settle(result, "MATCH")
  }

  if (expected.action === "DELAY") {
    result.notes.push(`delay window ends at ${expected.releaseAt} - nothing executed yet`)
    result.recheckAt = Math.max(expected.releaseAt, now)
    return settle(result, "PENDING")
  }

  // ALLOW expected, nothing executed: absence of a transaction is not proof
  // of a successful allow - keep watching for execution or registry drift.
  result.notes.push("no execution observed yet - an allow is only confirmed by its execution")
  result.recheckAt = now
  return settle(result, "PENDING")
}

/** Convenience: build the expectation and reconcile in one call. */
export function expectedAndReconcile(
  verdict: RegistryVerdictState,
  options: ExpectedEnforcementOptions,
  current: ChainStateSnapshot,
  value: bigint,
  now: number,
): { expected: ExpectedEnforcement; result: ReconciliationResult } {
  const expected = expectedEnforcementOf(verdict, options)
  return { expected, result: reconcile({ expected, current, value, now }) }
}
