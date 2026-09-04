import { useState } from "react"
import {
  type SecurityAction,
  type SecurityContext,
  type AuthorizationResult,
  authorizeAllActions,
} from "../actionAuthorization.js"

/**
 * Issue #86: Critical UI Action Authorization UI
 *
 * Shows the authorization status of all security-sensitive actions.
 * Each action is evaluated against the current security context and
 * displayed as authorized or denied with an explanation.
 */

function actionLabel(action: SecurityAction): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function actionIcon(action: SecurityAction): string {
  switch (action) {
    case "approve":
      return "✓"
    case "execute":
      return "▶"
    case "retry_enforcement":
      return "↻"
    case "override":
      return "⚡"
    case "change_policy":
      return "⚙"
    case "disable_protection":
      return "⊘"
    default:
      return "○"
  }
}

// ─── Demo contexts ───────────────────────────────────────────────────

const CTX_HEALTHY: SecurityContext = {
  txState: "verdict",
  verdictFresh: true,
  chainId: 11155111,
  expectedChainId: 11155111,
  isOwner: true,
  isFrozen: false,
  enforcementSynced: true,
  identityMatch: true,
  verdictAllows: true,
}

const CTX_BLOCKED: SecurityContext = {
  txState: "blocked",
  verdictFresh: true,
  chainId: 11155111,
  expectedChainId: 11155111,
  isOwner: true,
  isFrozen: false,
  enforcementSynced: true,
  identityMatch: true,
  verdictAllows: false,
}

const CTX_FROZEN: SecurityContext = {
  txState: "verdict",
  verdictFresh: true,
  chainId: 11155111,
  expectedChainId: 11155111,
  isOwner: true,
  isFrozen: true,
  enforcementSynced: true,
  identityMatch: true,
  verdictAllows: true,
}

const CTX_NOT_OWNER: SecurityContext = {
  txState: "verdict",
  verdictFresh: true,
  chainId: 11155111,
  expectedChainId: 11155111,
  isOwner: false,
  isFrozen: false,
  enforcementSynced: true,
  identityMatch: true,
  verdictAllows: true,
}

// ─── Action row ──────────────────────────────────────────────────────

function ActionRow({ result }: { result: AuthorizationResult }) {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div
      className={`auth-action-row ${result.allowed ? "auth-action-allowed" : "auth-action-denied"}`}
      onClick={() => setShowDetail(!showDetail)}
    >
      <div className="auth-action-header">
        <span className="auth-action-icon">{actionIcon(result.action)}</span>
        <span className="auth-action-name">{actionLabel(result.action)}</span>
        <span className={`auth-action-badge ${result.allowed ? "auth-badge-allowed" : "auth-badge-denied"}`}>
          {result.allowed ? "AUTHORIZED" : "DENIED"}
        </span>
      </div>
      <p className="auth-action-explanation">{result.explanation}</p>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function ActionAuthCard() {
  const [demoMode, setDemoMode] = useState<"healthy" | "blocked" | "frozen" | "not_owner">("healthy")

  const contexts: Record<string, SecurityContext> = {
    healthy: CTX_HEALTHY,
    blocked: CTX_BLOCKED,
    frozen: CTX_FROZEN,
    not_owner: CTX_NOT_OWNER,
  }

  const ctx = contexts[demoMode]
  const results = authorizeAllActions(ctx)
  const deniedCount = Array.from(results.values()).filter((r) => !r.allowed).length

  return (
    <section className="card auth-action-card">
      <h2>Action authorization</h2>
      <p className="auth-action-description">
        Centralized authorization layer. Security-sensitive buttons are only
        enabled after evaluating the current security state. Rendering an
        action and authorizing it are two separate operations.
      </p>

      <div className="auth-action-controls">
        <button type="button" className={demoMode === "healthy" ? "auth-demo-active" : ""} onClick={() => setDemoMode("healthy")}>
          Healthy
        </button>
        <button type="button" className={demoMode === "blocked" ? "auth-demo-blocked" : ""} onClick={() => setDemoMode("blocked")}>
          Blocked
        </button>
        <button type="button" className={demoMode === "frozen" ? "auth-demo-frozen" : ""} onClick={() => setDemoMode("frozen")}>
          Frozen
        </button>
        <button type="button" className={demoMode === "not_owner" ? "auth-demo-notowner" : ""} onClick={() => setDemoMode("not_owner")}>
          Not owner
        </button>
      </div>

      {/* Context summary */}
      <div className="auth-context-summary">
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">TX State</span>
          <span className="auth-ctx-value">{ctx.txState}</span>
        </div>
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">Chain</span>
          <span className="auth-ctx-value">{ctx.chainId === ctx.expectedChainId ? "✓ Correct" : "✕ Wrong"}</span>
        </div>
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">Owner</span>
          <span className="auth-ctx-value">{ctx.isOwner ? "✓ Yes" : "✕ No"}</span>
        </div>
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">Frozen</span>
          <span className="auth-ctx-value">{ctx.isFrozen ? "✓ Frozen" : "— No"}</span>
        </div>
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">Identity</span>
          <span className="auth-ctx-value">{ctx.identityMatch ? "✓ Match" : "✕ Mismatch"}</span>
        </div>
        <div className="auth-ctx-item">
          <span className="auth-ctx-label">Verdict</span>
          <span className="auth-ctx-value">{ctx.verdictAllows ? "✓ Allows" : "✕ Blocks"}</span>
        </div>
      </div>

      {/* Denied summary */}
      {deniedCount > 0 && (
        <div className="auth-denied-summary">
          <span className="auth-denied-count">{deniedCount} action{deniedCount !== 1 ? "s" : ""} denied</span>
        </div>
      )}

      {/* Action list */}
      <div className="auth-action-list">
        {Array.from(results.values()).map((result) => (
          <ActionRow key={result.action} result={result} />
        ))}
      </div>
    </section>
  )
}
