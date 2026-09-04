/**
 * Issue #82: Transaction State Machine & Stale State Protection
 *
 * Deterministic frontend state machine for transaction security states.
 * Only valid lifecycle transitions are allowed; stale, invalid, or
 * out-of-order updates are rejected.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SecurityState =
  | "DETECTED"
  | "ANALYZING"
  | "VERDICT_READY"
  | "ENFORCEMENT_PENDING"
  | "ENFORCED"
  | "ANALYSIS_FAILED"
  | "BLOCKED"
  | "ENFORCEMENT_FAILED"

export type SyncStatus = "verified" | "pending" | "error" | "stale"

export interface StateUpdate {
  /** Transaction this update applies to */
  txHash: string
  /** New state */
  state: SecurityState
  /** Monotonically increasing version number */
  version: number
  /** ISO timestamp */
  timestamp: string
  /** Human-readable reason for the transition */
  reason?: string
}

export interface TransactionState {
  /** Transaction hash */
  txHash: string
  /** Current security state */
  current: SecurityState
  /** Previous state (before last transition) */
  previous: SecurityState | null
  /** Version counter — incremented on every valid transition */
  version: number
  /** ISO timestamp of last update */
  lastUpdated: string
  /** Synchronization status */
  syncStatus: SyncStatus
  /** History of all transitions */
  history: StateTransition[]
}

export interface StateTransition {
  from: SecurityState
  to: SecurityState
  version: number
  timestamp: string
  reason?: string
}

export interface TransitionResult {
  /** Whether the transition was accepted */
  accepted: boolean
  /** Current state after the update (or unchanged if rejected) */
  state: TransactionState
  /** Rejection reason if not accepted */
  rejectionReason?: string
}

// ─── Valid transitions ───────────────────────────────────────────────

/**
 * Defines which states can transition to which other states.
 * A transaction's security state may only move forward through
 * a valid, verified transition.
 */
const VALID_TRANSITIONS: Record<SecurityState, SecurityState[]> = {
  DETECTED: ["ANALYZING"],
  ANALYZING: ["VERDICT_READY", "ANALYSIS_FAILED"],
  VERDICT_READY: ["ENFORCEMENT_PENDING", "BLOCKED"],
  ENFORCEMENT_PENDING: ["ENFORCED", "ENFORCEMENT_FAILED"],
  ENFORCED: [], // Terminal state — no forward transition
  ANALYSIS_FAILED: [], // Terminal failure
  BLOCKED: [], // Terminal state — blocked
  ENFORCEMENT_FAILED: [], // Terminal failure
}

/**
 * Terminal states cannot be transitioned out of.
 */
export const TERMINAL_STATES: SecurityState[] = [
  "ENFORCED",
  "ANALYSIS_FAILED",
  "BLOCKED",
  "ENFORCEMENT_FAILED",
]

/**
 * Check if a transition from one state to another is valid.
 */
export function isValidTransition(from: SecurityState, to: SecurityState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Get all valid next states from a given state.
 */
export function getValidNextStates(state: SecurityState): SecurityState[] {
  return VALID_TRANSITIONS[state] ?? []
}

// ─── State machine ───────────────────────────────────────────────────

export class TransactionStateMachine {
  private transactions = new Map<string, TransactionState>()

  /**
   * Get or create the state for a transaction.
   */
  getState(txHash: string): TransactionState {
    let state = this.transactions.get(txHash)
    if (!state) {
      state = {
        txHash,
        current: "DETECTED",
        previous: null,
        version: 0,
        lastUpdated: new Date().toISOString(),
        syncStatus: "pending",
        history: [],
      }
      this.transactions.set(txHash, state)
    }
    return state
  }

  /**
   * Apply a state update. Returns whether it was accepted.
   * Rejects if:
   * - Version is older than or equal to current
   * - Transaction hash doesn't match
   * - Transition is not valid
   * - Current state is terminal
   */
  applyUpdate(update: StateUpdate): TransitionResult {
    const state = this.getState(update.txHash)

    // Validate transaction identity
    if (update.txHash !== state.txHash) {
      return {
        accepted: false,
        state,
        rejectionReason: `Transaction hash mismatch: expected ${state.txHash}, got ${update.txHash}`,
      }
    }

    // Validate version (must be strictly newer)
    if (update.version <= state.version) {
      return {
        accepted: false,
        state: { ...state, syncStatus: "stale" },
        rejectionReason: `Stale update: version ${update.version} <= current ${state.version}`,
      }
    }

    // Validate transition
    if (!isValidTransition(state.current, update.state)) {
      return {
        accepted: false,
        state: { ...state, syncStatus: "error" },
        rejectionReason: `Invalid transition: ${state.current} → ${update.state}`,
      }
    }

    // Apply the transition
    const transition: StateTransition = {
      from: state.current,
      to: update.state,
      version: update.version,
      timestamp: update.timestamp,
      reason: update.reason,
    }

    const newState: TransactionState = {
      ...state,
      previous: state.current,
      current: update.state,
      version: update.version,
      lastUpdated: update.timestamp,
      syncStatus: "verified",
      history: [...state.history, transition],
    }

    this.transactions.set(update.txHash, newState)

    return {
      accepted: true,
      state: newState,
    }
  }

  /**
   * Force-set state (for initialization or reset).
   * Skips version/transition validation.
   */
  forceState(txHash: string, state: SecurityState, version: number): TransactionState {
    const existing = this.getState(txHash)
    const newState: TransactionState = {
      txHash,
      current: state,
      previous: existing.current !== state ? existing.current : existing.previous,
      version,
      lastUpdated: new Date().toISOString(),
      syncStatus: "verified",
      history: existing.current !== state
        ? [...existing.history, {
            from: existing.current,
            to: state,
            version,
            timestamp: new Date().toISOString(),
            reason: "force-set",
          }]
        : existing.history,
    }
    this.transactions.set(txHash, newState)
    return newState
  }

  /**
   * Check if a transaction is in a terminal state.
   */
  isTerminal(txHash: string): boolean {
    const state = this.transactions.get(txHash)
    return state ? TERMINAL_STATES.includes(state.current) : false
  }

  /**
   * Get all tracked transactions.
   */
  getAllTransactions(): TransactionState[] {
    return Array.from(this.transactions.values())
  }

  /**
   * Clear all state (for testing or reset).
   */
  clear(): void {
    this.transactions.clear()
  }
}

// ─── Singleton ───────────────────────────────────────────────────────

let _instance: TransactionStateMachine | null = null

export function getStateMachine(): TransactionStateMachine {
  if (!_instance) {
    _instance = new TransactionStateMachine()
  }
  return _instance
}

// ─── Display helpers ─────────────────────────────────────────────────

export function stateColor(state: SecurityState): string {
  switch (state) {
    case "DETECTED": return "#6b7280"
    case "ANALYZING": return "#3b82f6"
    case "VERDICT_READY": return "#8b5cf6"
    case "ENFORCEMENT_PENDING": return "#d97706"
    case "ENFORCED": return "#16a34a"
    case "BLOCKED": return "#dc2626"
    case "ANALYSIS_FAILED": return "#ef4444"
    case "ENFORCEMENT_FAILED": return "#ef4444"
  }
}

export function stateLabel(state: SecurityState): string {
  return state.replace(/_/g, " ")
}

export function syncColor(status: SyncStatus): string {
  switch (status) {
    case "verified": return "#16a34a"
    case "pending": return "#d97706"
    case "error": return "#dc2626"
    case "stale": return "#6b7280"
  }
}

export function syncLabel(status: SyncStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX = "0xdemo1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaabbbbccccdddd"

export function createDemoTransitions(): { txHash: string; updates: StateUpdate[] } {
  const now = Date.now()
  return {
    txHash: DEMO_TX,
    updates: [
      { txHash: DEMO_TX, state: "ANALYZING", version: 1, timestamp: new Date(now - 60000).toISOString(), reason: "Rule engine started" },
      { txHash: DEMO_TX, state: "VERDICT_READY", version: 2, timestamp: new Date(now - 30000).toISOString(), reason: "Risk score: 85/100" },
      { txHash: DEMO_TX, state: "ENFORCEMENT_PENDING", version: 3, timestamp: new Date(now - 15000).toISOString(), reason: "Enforcement queued" },
      { txHash: DEMO_TX, state: "ENFORCED", version: 4, timestamp: new Date(now - 5000).toISOString(), reason: "Guard frozen" },
    ],
  }
}

export { DEMO_TX }
