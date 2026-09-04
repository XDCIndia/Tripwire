import { useState } from "react"
import {
  type ReconciliationResult,
  type VerificationStatus,
  createDemoResults,
  statusLabel,
  statusColor,
  actionLabel,
  actionColor,
  guardStateColor,
} from "../trustMinimizedVerification.js"

/**
 * Issue #80: Trust-Minimized Risk Verification & On-Chain State Reconciliation UI
 *
 * Displays per-transaction reconciliation between backend verdict,
 * on-chain RiskRegistry verdict, and TripwireGuard state.
 */

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

// ─── Status indicator ────────────────────────────────────────────────

function StatusDot({ status }: { status: VerificationStatus }) {
  return <span className="verify-dot" style={{ background: statusColor(status) }} />
}

// ─── Source row ──────────────────────────────────────────────────────

function SourceRow({ label, action, color }: { label: string; action: string; color: string }) {
  return (
    <div className="verify-source-row">
      <span className="verify-source-label">{label}</span>
      <span className="verify-source-action" style={{ color }}>{action}</span>
    </div>
  )
}

// ─── Transaction row ─────────────────────────────────────────────────

function TransactionRow({
  result,
  expanded,
  onToggle,
}: {
  result: ReconciliationResult
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className={`verify-tx ${result.status === "mismatch" ? "verify-tx-mismatch" : ""}`}>
      <div className="verify-tx-header" onClick={onToggle}>
        <StatusDot status={result.status} />
        <span className="verify-tx-hash mono">{shortHash(result.txHash)}</span>
        <span className="verify-tx-status" style={{ color: statusColor(result.status) }}>
          {statusLabel(result.status)}
        </span>
        <span className="verify-tx-toggle">{expanded ? "▾" : "▸"}</span>
      </div>

      {/* Quick summary */}
      <div className="verify-tx-summary">
        <span className="verify-tx-source">
          Backend: <span style={{ color: actionColor(result.backend?.action ?? "allow") }}>
            {result.backend ? actionLabel(result.backend.action) : "—"}
          </span>
        </span>
        <span className="verify-tx-source">
          On-chain: <span style={{ color: actionColor(result.onChain?.action ?? "allow") }}>
            {result.onChain ? actionLabel(result.onChain.action) : "—"}
          </span>
        </span>
        <span className="verify-tx-source">
          Guard: <span style={{ color: result.guard ? guardStateColor(result.guard.enabled ? "enabled" : "disabled") : "#6b7280" }}>
            {result.guard ? (result.guard.frozen ? "FROZEN" : result.guard.enabled ? "ENABLED" : "DISABLED") : "—"}
          </span>
        </span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="verify-tx-details">
          {/* Backend verdict */}
          {result.backend && (
            <div className="verify-detail-section">
              <h4>Backend verdict</h4>
              <SourceRow label="Action" action={actionLabel(result.backend.action)} color={actionColor(result.backend.action)} />
              <SourceRow label="Score" action={`${result.backend.score}/100`} color="var(--text-h)" />
              {result.backend.reasons && result.backend.reasons.length > 0 && (
                <div className="verify-reasons">
                  {result.backend.reasons.map((r, i) => <p key={i}>{r}</p>)}
                </div>
              )}
              <span className="verify-timestamp">{new Date(result.backend.timestamp).toLocaleString()}</span>
            </div>
          )}

          {/* On-chain verdict */}
          {result.onChain ? (
            <div className="verify-detail-section">
              <h4>On-chain RiskRegistry</h4>
              <SourceRow label="Action" action={actionLabel(result.onChain.action)} color={actionColor(result.onChain.action)} />
              <SourceRow label="Score" action={`${result.onChain.score}/100`} color="var(--text-h)" />
              <SourceRow label="Block" action={`#${result.onChain.blockNumber}`} color="var(--muted)" />
              <span className="verify-timestamp">{new Date(result.onChain.readAt).toLocaleString()}</span>
            </div>
          ) : (
            <div className="verify-detail-section verify-detail-missing">
              <h4>On-chain RiskRegistry</h4>
              <p>No on-chain verdict found for this transaction.</p>
            </div>
          )}

          {/* Guard state */}
          {result.guard ? (
            <div className="verify-detail-section">
              <h4>TripwireGuard state</h4>
              <SourceRow label="Enabled" action={result.guard.enabled ? "Yes" : "No"} color={result.guard.enabled ? "#16a34a" : "#d97706"} />
              <SourceRow label="Frozen" action={result.guard.frozen ? "Yes" : "No"} color={result.guard.frozen ? "#dc2626" : "#16a34a"} />
              <SourceRow label="Block" action={`#${result.guard.blockNumber}`} color="var(--muted)" />
              <span className="verify-timestamp">{new Date(result.guard.readAt).toLocaleString()}</span>
            </div>
          ) : (
            <div className="verify-detail-section verify-detail-missing">
              <h4>TripwireGuard state</h4>
              <p>Guard state not available.</p>
            </div>
          )}

          {/* Mismatch reasons */}
          {result.mismatchReasons.length > 0 && (
            <div className="verify-mismatch-reasons">
              {result.mismatchReasons.map((reason, i) => (
                <p key={i}>{reason}</p>
              ))}
            </div>
          )}

          <div className="verify-reconciled">
            Reconciled: {new Date(result.reconciledAt).toLocaleTimeString()} · Chain {result.chainId}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Global status header ────────────────────────────────────────────

function GlobalStatusHeader({ results }: { results: ReconciliationResult[] }) {
  const worst = results.reduce<VerificationStatus>((acc, r) => {
    if (r.status === "mismatch") return "mismatch"
    if (r.status === "unknown" && acc !== "mismatch") return "unknown"
    if (r.status === "pending" && acc === "verified") return "pending"
    return acc
  }, "verified")

  const mismatchCount = results.filter((r) => r.status === "mismatch").length
  const verifiedCount = results.filter((r) => r.status === "verified").length
  const pendingCount = results.filter((r) => r.status === "pending").length

  return (
    <div className="verify-global" style={{ borderColor: statusColor(worst) }}>
      <div className="verify-global-main">
        <StatusDot status={worst} />
        <span className="verify-global-label" style={{ color: statusColor(worst) }}>
          {statusLabel(worst)}
        </span>
      </div>
      <div className="verify-global-stats">
        {verifiedCount > 0 && <span className="verify-stat verify-stat-verified">{verifiedCount} verified</span>}
        {mismatchCount > 0 && <span className="verify-stat verify-stat-mismatch">{mismatchCount} mismatched</span>}
        {pendingCount > 0 && <span className="verify-stat verify-stat-pending">{pendingCount} pending</span>}
      </div>
      {mismatchCount > 0 && (
        <div className="verify-global-warning">
          ⚠ Security-sensitive actions are disabled while mismatches exist.
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function TrustVerificationCard() {
  const [demoMode, setDemoMode] = useState(false)
  const [expandedTx, setExpandedTx] = useState<string | null>(null)

  const results = demoMode ? createDemoResults() : []

  function toggleExpand(txHash: string) {
    setExpandedTx(expandedTx === txHash ? null : txHash)
  }

  return (
    <section className="card verify-card">
      <h2>Security verification</h2>
      <p className="verify-description">
        Trust-minimized verification: backend verdicts are reconciled with
        on-chain RiskRegistry and TripwireGuard state. Backend risk is
        informational until confirmed by the blockchain.
      </p>

      <div className="verify-controls">
        <button
          type="button"
          className={demoMode ? "verify-btn-active" : ""}
          onClick={() => { setDemoMode(!demoMode); setExpandedTx(null) }}
        >
          {demoMode ? "Using demo data" : "Load demo verification"}
        </button>
      </div>

      {!demoMode && (
        <p className="verify-hint">
          Verification activates when transactions are tracked. Click "Load demo verification" to see samples.
        </p>
      )}

      {demoMode && results.length > 0 && (
        <>
          {/* Global status */}
          <GlobalStatusHeader results={results} />

          {/* Transaction list */}
          <div className="verify-tx-list">
            {results.map((result) => (
              <TransactionRow
                key={result.txHash}
                result={result}
                expanded={expandedTx === result.txHash}
                onToggle={() => toggleExpand(result.txHash)}
              />
            ))}
          </div>
        </>
      )}

      {!demoMode && (
        <div className="verify-empty">
          <p>No transactions to verify.</p>
        </div>
      )}
    </section>
  )
}
