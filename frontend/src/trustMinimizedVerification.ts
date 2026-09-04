/**
 * Issue #80: Trust-Minimized Risk Verification & On-Chain State Reconciliation
 *
 * Independently reads on-chain RiskRegistry and TripwireGuard state,
 * compares with backend risk feed, and surfaces VERIFIED / MISMATCH /
 * PENDING / UNKNOWN status. Backend risk is informational until
 * reconciled with blockchain state.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type VerificationStatus = "verified" | "mismatch" | "pending" | "unknown"

export type RiskAction = "allow" | "delay" | "block" | "freeze"

export type GuardState = "enabled" | "disabled" | "frozen" | "unknown"

/**
 * Backend-provided risk verdict (from the risk feed / API).
 */
export interface BackendVerdict {
  /** Transaction hash */
  txHash: string
  /** Risk action from backend */
  action: RiskAction
  /** Risk score 0-100 */
  score: number
  /** Status label */
  status?: string
  /** Human-readable reasons */
  reasons?: string[]
  /** Backend timestamp */
  timestamp: string
}

/**
 * On-chain state read from RiskRegistry contract.
 */
export interface OnChainRegistryVerdict {
  /** Transaction hash */
  txHash: string
  /** On-chain risk action */
  action: RiskAction
  /** On-chain score */
  score: number
  /** Block number where verdict was recorded */
  blockNumber: number
  /** Timestamp of on-chain read */
  readAt: string
}

/**
 * On-chain state read from TripwireGuard contract.
 */
export interface OnChainGuardState {
  /** Whether the guard is enabled on the Safe */
  enabled: boolean
  /** Whether the guard is frozen */
  frozen: boolean
  /** Per-transaction limit */
  perTxLimit: string
  /** Rolling limit */
  rollingLimit: string
  /** Block number of read */
  blockNumber: number
  /** Timestamp of on-chain read */
  readAt: string
}

/**
 * Reconciled verification result for a single transaction.
 */
export interface ReconciliationResult {
  /** Transaction hash */
  txHash: string
  /** Overall verification status */
  status: VerificationStatus
  /** Backend verdict */
  backend: BackendVerdict | null
  /** On-chain registry verdict */
  onChain: OnChainRegistryVerdict | null
  /** On-chain guard state */
  guard: OnChainGuardState | null
  /** Reasons for mismatch (if any) */
  mismatchReasons: string[]
  /** Timestamp of reconciliation */
  reconciledAt: string
  /** Chain ID used for verification */
  chainId: number
  /** Whether backend and on-chain agree */
  sourcesAgree: boolean
}

/**
 * Overall security state for the dashboard.
 */
export interface SecurityVerificationState {
  /** Per-transaction results */
  transactions: Map<string, ReconciliationResult>
  /** Global status (worst of all transactions) */
  globalStatus: VerificationStatus
  /** Chain ID being verified */
  chainId: number
  /** Last reconciliation timestamp */
  lastReconciled: string
}

// ─── Reconciliation engine ───────────────────────────────────────────

/**
 * Compare backend and on-chain verdicts.
 * Returns whether they agree and any mismatch reasons.
 */
function compareVerdicts(
  backend: BackendVerdict | null,
  onChain: OnChainRegistryVerdict | null,
): { agree: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (!backend) {
    reasons.push("No backend verdict available")
    return { agree: false, reasons }
  }

  if (!onChain) {
    reasons.push("No on-chain verdict available — cannot verify")
    return { agree: false, reasons }
  }

  // Compare actions
  if (backend.action !== onChain.action) {
    reasons.push(
      `Backend says ${backend.action.toUpperCase()} but on-chain says ${onChain.action.toUpperCase()}`,
    )
  }

  // Compare scores (allow 5-point tolerance for timing differences)
  const scoreDiff = Math.abs(backend.score - onChain.score)
  if (scoreDiff > 5) {
    reasons.push(
      `Score mismatch: backend ${backend.score} vs on-chain ${onChain.score}`,
    )
  }

  // Validate transaction identity
  if (backend.txHash.toLowerCase() !== onChain.txHash.toLowerCase()) {
    reasons.push("Transaction hash mismatch between backend and on-chain")
  }

  return { agree: reasons.length === 0, reasons }
}

/**
 * Determine verification status from all available data.
 */
function determineStatus(
  backend: BackendVerdict | null,
  onChain: OnChainRegistryVerdict | null,
  guard: OnChainGuardState | null,
  rpcError: boolean,
  chainMismatch: boolean,
): { status: VerificationStatus; reasons: string[] } {
  const reasons: string[] = []

  // RPC error → UNKNOWN
  if (rpcError) {
    reasons.push("RPC error — on-chain state could not be read")
    return { status: "unknown", reasons }
  }

  // Chain mismatch → UNKNOWN
  if (chainMismatch) {
    reasons.push("Network/chain mismatch — verification invalidated")
    return { status: "unknown", reasons }
  }

  // No backend verdict → PENDING
  if (!backend) {
    reasons.push("No backend verdict received yet")
    return { status: "pending", reasons }
  }

  // No on-chain data → PENDING
  if (!onChain) {
    reasons.push("Waiting for on-chain confirmation")
    return { status: "pending", reasons }
  }

  // Compare backend vs on-chain
  const { agree, reasons: mismatchReasons } = compareVerdicts(backend, onChain)
  if (!agree) {
    reasons.push(...mismatchReasons)
    return { status: "mismatch", reasons }
  }

  // Guard state check
  if (guard) {
    if (guard.frozen && backend.action !== "freeze") {
      reasons.push("Guard is frozen but backend does not reflect this")
      return { status: "mismatch", reasons }
    }
  }

  return { status: "verified", reasons }
}

/**
 * Reconcile all sources for a single transaction.
 */
export function reconcileTransaction(
  backend: BackendVerdict | null,
  onChain: OnChainRegistryVerdict | null,
  guard: OnChainGuardState | null,
  chainId: number,
  expectedChainId: number,
  rpcError = false,
): ReconciliationResult {
  const chainMismatch = chainId !== expectedChainId
  const { status, reasons } = determineStatus(backend, onChain, guard, rpcError, chainMismatch)
  const txHash = backend?.txHash ?? onChain?.txHash ?? ""

  return {
    txHash,
    status,
    backend,
    onChain,
    guard,
    mismatchReasons: reasons,
    reconciledAt: new Date().toISOString(),
    chainId: expectedChainId,
    sourcesAgree: status === "verified",
  }
}

// ─── Display helpers ─────────────────────────────────────────────────

export function statusLabel(status: VerificationStatus): string {
  switch (status) {
    case "verified": return "VERIFIED"
    case "mismatch": return "MISMATCH"
    case "pending": return "PENDING"
    case "unknown": return "UNKNOWN"
  }
}

export function statusColor(status: VerificationStatus): string {
  switch (status) {
    case "verified": return "#16a34a"
    case "mismatch": return "#dc2626"
    case "pending": return "#d97706"
    case "unknown": return "#6b7280"
  }
}

export function actionLabel(action: RiskAction): string {
  return action.toUpperCase()
}

export function actionColor(action: RiskAction): string {
  switch (action) {
    case "allow": return "#16a34a"
    case "delay": return "#d97706"
    case "block": return "#dc2626"
    case "freeze": return "#6b7280"
  }
}

export function guardStateLabel(state: GuardState): string {
  switch (state) {
    case "enabled": return "ENABLED"
    case "disabled": return "DISABLED"
    case "frozen": return "FROZEN"
    case "unknown": return "UNKNOWN"
  }
}

export function guardStateColor(state: GuardState): string {
  switch (state) {
    case "enabled": return "#16a34a"
    case "disabled": return "#d97706"
    case "frozen": return "#dc2626"
    case "unknown": return "#6b7280"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX = "0xdemo1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaabbbbccccdddd"

export function createDemoResults(): ReconciliationResult[] {
  const now = new Date().toISOString()

  return [
    // Verified: backend and on-chain agree
    reconcileTransaction(
      { txHash: DEMO_TX, action: "block", score: 85, reasons: ["Unlimited approval", "First-seen counterparty"], timestamp: now },
      { txHash: DEMO_TX, action: "block", score: 85, blockNumber: 12345678, readAt: now },
      { enabled: true, frozen: false, perTxLimit: "10000000000000000000", rollingLimit: "50000000000000000000", blockNumber: 12345678, readAt: now },
      50, 50,
    ),
    // Mismatch: backend says block, on-chain says allow
    reconcileTransaction(
      { txHash: `${DEMO_TX}_mismatch`, action: "block", score: 90, reasons: ["Dangerous function"], timestamp: now },
      { txHash: `${DEMO_TX}_mismatch`, action: "allow", score: 10, blockNumber: 12345677, readAt: now },
      { enabled: true, frozen: false, perTxLimit: "10000000000000000000", rollingLimit: "50000000000000000000", blockNumber: 12345677, readAt: now },
      50, 50,
    ),
    // Pending: backend only, no on-chain
    reconcileTransaction(
      { txHash: `${DEMO_TX}_pending`, action: "delay", score: 50, timestamp: now },
      null,
      null,
      50, 50,
    ),
    // Unknown: RPC error
    reconcileTransaction(
      { txHash: `${DEMO_TX}_rpcerr`, action: "allow", score: 10, timestamp: now },
      null,
      null,
      50, 50,
      true,
    ),
  ]
}

export { DEMO_TX }
