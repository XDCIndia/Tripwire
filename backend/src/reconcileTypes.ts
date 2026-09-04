/**
 * On-chain verdict attestation & enforcement reconciliation - domain types
 * (issue #50).
 *
 * The relayer writes a verdict; this layer refuses to assume that means the
 * verdict was *enforced*. On a real blockchain a Safe transaction can sit
 * pending, revert, be dropped or replaced, or the protection can silently
 * stop applying (registry overwritten, guard unfrozen, guard detached).
 * Everything in `reconcile*` exists to compare what the backend *expected*
 * against what the chain *actually shows* - and to scream when they differ.
 *
 * Statuses mirror the issue's outcome set exactly:
 *   MATCH      - expected enforcement matches observed on-chain state
 *   MISMATCH   - expected protection is NOT what the chain shows (critical)
 *   PENDING    - outcome not settled yet; must be re-checked later
 *   REVERTED   - an execution attempt reverted (for a BLOCK: enforcement held)
 *   DROPPED    - the transaction was dropped or replaced on-chain
 *
 * There is deliberately no "CONFIRMED" that can be reached from a failure:
 * a MISMATCH stays a MISMATCH forever (a later, healthy check is a new
 * result, never an edit of the old one).
 */

import type { RiskStatusValue } from "./verdict.js"

export const RECONCILIATION_STATUSES = ["MATCH", "MISMATCH", "PENDING", "REVERTED", "DROPPED"] as const
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number]

/** What the Guard would do with a transaction, per the enforcement rules. */
export type EnforcementAction = "ALLOW" | "DELAY" | "BLOCK"

/** Registry/verdict status names, for human-readable reports. */
export const STATUS_NAMES = ["UNSCORED", "LOW_RISK", "DELAYED", "HIGH_RISK", "FROZEN"] as const

/** What the verdict + Guard config say a transaction's fate should be. */
export interface ExpectedEnforcement {
  action: EnforcementAction
  /** Human-readable why, e.g. "verdict HIGH_RISK" or "guard is frozen". */
  reason: string
  /** The verdict status the expectation was derived from (0-4). */
  verdictStatus: RiskStatusValue
  /** Epoch seconds a DELAY expectation ends (0 when not a delay). */
  releaseAt: number
  /** True if the expectation relied on the Guard's freeze switch. */
  freezeExpected: boolean
}

/** What the chain shows when a reconciliation check runs. */
export interface RegistryVerdictState {
  status: RiskStatusValue
  score: number
  /** Registry epoch seconds the delay window ends at (0 when not DELAYED). */
  releaseAt: number
}

export type ExecutionObservationKind = "none" | "pending" | "success" | "reverted" | "dropped"

export interface ExecutionObservation {
  kind: ExecutionObservationKind
  /** When dropped: the tx hash that replaced it (if known). */
  replacedBy?: string | null
}

/** Guard controls as read on-chain at check time. */
export interface GuardChainState {
  frozen: boolean
  perTxLimit: bigint
  rollingLimit: bigint
  windowSpent: bigint
}

/** Everything reconcile() needs about the current chain. */
export interface ChainStateSnapshot {
  /** Current RiskRegistry verdict for the tx hash (null if absent). */
  registryVerdict: RegistryVerdictState | null
  /** Current TripwireGuard controls. */
  guard: GuardChainState
  /** Execution outcome observed so far for this Safe transaction. */
  execution: ExecutionObservation
}

export interface ReconciliationResult {
  status: ReconciliationStatus
  /** Why this status: expected side. */
  expected: { action: EnforcementAction; reason: string }
  /** Why this status: actual side. */
  actual: {
    registryStatus: RiskStatusValue | null
    registryStatusName: string
    guardFrozen: boolean
    executionKind: ExecutionObservationKind
  }
  /** Human-readable bullet notes explaining the verdict. */
  notes: string[]
  /** True when a security-critical protection gap is observed. */
  critical: boolean
  checkedAt: number
  /** When a PENDING result should be re-checked (null when settled). */
  recheckAt: number | null
}

/** Default backoff between automatic re-checks of unresolved outcomes. */
export const DEFAULT_RECHECK_DELAY_MS = 60_000
/** Ceiling on automatic re-checks before a PENDING result stops polling
 * (it stays visible, never silently dropped or promoted). */
export const DEFAULT_MAX_RECHECKS = 20
