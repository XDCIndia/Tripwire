/**
 * Issue #86: Critical UI Action Authorization
 *
 * Centralized frontend authorization layer for all security-sensitive
 * actions. Evaluates current security state, transaction identity,
 * verdict freshness, user permissions, chain/network, enforcement status,
 * and required confirmations before exposing an action.
 *
 * Rendering an action and authorizing it are two separate operations.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SecurityAction =
  | "approve"
  | "execute"
  | "retry_enforcement"
  | "override"
  | "change_policy"
  | "disable_protection"

export type DenialReason =
  | "unknown_state"
  | "stale_verdict"
  | "blocked"
  | "conflict"
  | "analyzing"
  | "wrong_chain"
  | "insufficient_permissions"
  | "frozen"
  | "no_verdict"
  | "mismatched_identity"

export interface AuthorizationResult {
  /** Whether the action is authorized */
  allowed: boolean
  /** The action that was evaluated */
  action: SecurityAction
  /** If denied, why */
  denialReason?: DenialReason
  /** Human-readable explanation */
  explanation: string
  /** When this authorization was evaluated */
  evaluatedAt: string
}

export interface SecurityContext {
  /** Current transaction state */
  txState: "unknown" | "analyzing" | "pending" | "scored" | "simulated" | "verdict" | "stale" | "blocked" | "conflict" | "executed" | "reverted"
  /** Whether the verdict is fresh (within acceptable age) */
  verdictFresh: boolean
  /** Current chain ID */
  chainId: number
  /** Expected chain ID */
  expectedChainId: number
  /** Whether the connected wallet is the owner/authorized user */
  isOwner: boolean
  /** Whether the guard is frozen */
  isFrozen: boolean
  /** Whether enforcement is in sync */
  enforcementSynced: boolean
  /** Whether the transaction identity matches the reviewed version */
  identityMatch: boolean
  /** Whether the risk verdict allows execution */
  verdictAllows: boolean
}

// ─── Authorization rules ─────────────────────────────────────────────

const ACTION_RULES: Record<SecurityAction, (ctx: SecurityContext) => DenialReason | null> = {
  approve: (ctx) => {
    if (ctx.txState === "unknown") return "unknown_state"
    if (ctx.txState === "analyzing") return "analyzing"
    if (ctx.txState === "blocked") return "blocked"
    if (ctx.txState === "conflict") return "conflict"
    if (ctx.txState === "stale") return "stale_verdict"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    if (!ctx.identityMatch) return "mismatched_identity"
    return null
  },

  execute: (ctx) => {
    if (ctx.txState === "unknown") return "unknown_state"
    if (ctx.txState === "analyzing") return "analyzing"
    if (ctx.txState === "stale") return "stale_verdict"
    if (ctx.txState === "blocked") return "blocked"
    if (ctx.txState === "conflict") return "conflict"
    if (ctx.isFrozen) return "frozen"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    if (!ctx.identityMatch) return "mismatched_identity"
    if (!ctx.verdictFresh) return "stale_verdict"
    if (!ctx.verdictAllows) return "blocked"
    return null
  },

  retry_enforcement: (ctx) => {
    if (ctx.txState === "unknown") return "unknown_state"
    if (ctx.txState === "analyzing") return "analyzing"
    if (ctx.isFrozen) return "frozen"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    if (ctx.enforcementSynced) return null // already synced, no need to retry
    return null
  },

  override: (ctx) => {
    if (!ctx.isOwner) return "insufficient_permissions"
    if (ctx.txState === "unknown") return "unknown_state"
    if (ctx.txState === "analyzing") return "analyzing"
    if (ctx.isFrozen) return "frozen"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    return null
  },

  change_policy: (ctx) => {
    if (!ctx.isOwner) return "insufficient_permissions"
    if (ctx.isFrozen) return "frozen"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    return null
  },

  disable_protection: (ctx) => {
    if (!ctx.isOwner) return "insufficient_permissions"
    if (ctx.isFrozen) return "frozen"
    if (ctx.chainId !== ctx.expectedChainId) return "wrong_chain"
    return null
  },
}

// ─── Explanation messages ─────────────────────────────────────────────

function explainDenial(action: SecurityAction, reason: DenialReason): string {
  const actionLabel = action.replace(/_/g, " ")
  switch (reason) {
    case "unknown_state":
      return `Cannot ${actionLabel}: transaction security state is unknown.`
    case "stale_verdict":
      return `Cannot ${actionLabel}: verdict is stale or expired. Re-evaluate the transaction.`
    case "blocked":
      return `Cannot ${actionLabel}: transaction is blocked by risk verdict.`
    case "conflict":
      return `Cannot ${actionLabel}: transaction conflict detected. Resolve before proceeding.`
    case "analyzing":
      return `Cannot ${actionLabel}: transaction is still being analyzed. Wait for completion.`
    case "wrong_chain":
      return `Cannot ${actionLabel}: connected to wrong network. Switch to the correct chain.`
    case "insufficient_permissions":
      return `Cannot ${actionLabel}: connected wallet is not authorized for this action.`
    case "frozen":
      return `Cannot ${actionLabel}: Guard is frozen. All actions are blocked until unfrozen.`
    case "no_verdict":
      return `Cannot ${actionLabel}: no verdict exists for this transaction.`
    case "mismatched_identity":
      return `Cannot ${actionLabel}: transaction has changed since review. Re-authorize.`
  }
}

function explainAllowance(action: SecurityAction): string {
  switch (action) {
    case "approve":
      return "Transaction is ready for approval. Risk state allows proceeding."
    case "execute":
      return "All security checks passed. Transaction is safe to execute."
    case "retry_enforcement":
      return "Enforcement retry available. Verdict is fresh and guard is active."
    case "override":
      return "Owner override available. You have the authority to proceed."
    case "change_policy":
      return "Policy changes allowed. Guard is active and you are the owner."
    case "disable_protection":
      return "Protection can be disabled. You are the owner and guard is active."
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Check if a specific action is authorized given the current security context.
 * This is the centralized authorization function — all security-sensitive
 * buttons should call this before enabling themselves.
 */
export function authorizeAction(action: SecurityAction, ctx: SecurityContext): AuthorizationResult {
  const denialReason = ACTION_RULES[action](ctx)
  const allowed = denialReason === null

  return {
    allowed,
    action,
    denialReason: denialReason ?? undefined,
    explanation: allowed ? explainAllowance(action) : explainDenial(action, denialReason),
    evaluatedAt: new Date().toISOString(),
  }
}

/**
 * Check all security-sensitive actions at once.
 * Returns a map of action → authorization result.
 */
export function authorizeAllActions(ctx: SecurityContext): Map<SecurityAction, AuthorizationResult> {
  const actions: SecurityAction[] = ["approve", "execute", "retry_enforcement", "override", "change_policy", "disable_protection"]
  const results = new Map<SecurityAction, AuthorizationResult>()
  for (const action of actions) {
    results.set(action, authorizeAction(action, ctx))
  }
  return results
}

/**
 * Get the list of denied actions with their reasons.
 * Useful for displaying a summary of what's restricted.
 */
export function getDeniedActions(ctx: SecurityContext): AuthorizationResult[] {
  const results = authorizeAllActions(ctx)
  return Array.from(results.values()).filter((r) => !r.allowed)
}
