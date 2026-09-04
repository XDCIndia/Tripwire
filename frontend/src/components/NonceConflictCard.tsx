import { useState } from "react"
import {
  type NonceTransaction,
  type NonceConflict,
  type TxState,
  detectNonceConflicts,
  getConflictSeverity,
  getInvalidationWarning,
  shortHash,
} from "../nonceTracker.js"

/**
 * Issue #97: Nonce & Transaction Replacement Conflict Detection UI
 *
 * Shows when multiple transactions share the same nonce, identifies the
 * active vs superseded ones, and invalidates stale risk decisions. Users
 * can navigate from a superseded transaction to the active one.
 */

function stateColor(state: TxState): string {
  switch (state) {
    case "confirmed":
      return "#16a34a"
    case "active":
      return "#2563eb"
    case "pending":
      return "#d97706"
    case "replaced":
    case "superseded":
      return "#dc2626"
    case "reverted":
      return "#dc2626"
    case "stale":
      return "#6b7280"
    default:
      return "#6b7280"
  }
}

function stateEmoji(state: TxState): string {
  switch (state) {
    case "confirmed":
      return "✓"
    case "active":
      return "●"
    case "pending":
      return "○"
    case "replaced":
    case "superseded":
      return "⚠"
    case "reverted":
      return "✕"
    case "stale":
      return "—"
    default:
      return "?"
  }
}

function stateLabel(state: TxState): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

function riskColor(risk?: string): string {
  switch (risk) {
    case "high":
      return "#dc2626"
    case "medium":
      return "#d97706"
    default:
      return "#16a34a"
  }
}

// ─── Transaction row ─────────────────────────────────────────────────

function TxRow({
  tx,
  isActive,
  onNavigate,
}: {
  tx: NonceTransaction
  isActive: boolean
  onNavigate: (txHash: string) => void
}) {
  const color = stateColor(tx.state)
  return (
    <div className={`nonce-tx-row ${isActive ? "nonce-tx-active" : ""} ${tx.state === "superseded" || tx.state === "replaced" ? "nonce-tx-superseded" : ""}`}>
      <div className="nonce-tx-header">
        <span className="nonce-tx-state" style={{ color }}>
          {stateEmoji(tx.state)} {stateLabel(tx.state)}
        </span>
        <span className="nonce-tx-hash mono">{shortHash(tx.txHash)}</span>
        {tx.risk && (
          <span className="nonce-tx-risk" style={{ color: riskColor(tx.risk) }}>
            Risk: {tx.risk.toUpperCase()}
          </span>
        )}
      </div>
      {tx.description && <p className="nonce-tx-desc">{tx.description}</p>}
      {tx.state === "superseded" && (
        <button type="button" className="nonce-nav-btn" onClick={() => onNavigate(tx.txHash)}>
          View active transaction →
        </button>
      )}
    </div>
  )
}

// ─── Conflict row ────────────────────────────────────────────────────

function ConflictRow({ conflict }: { conflict: NonceConflict }) {
  const [expanded, setExpanded] = useState(!conflict.hasConflict)
  const severity = getConflictSeverity(conflict)
  const severityColor =
    severity === "critical" ? "#dc2626" : severity === "high" ? "#ea580c" : severity === "medium" ? "#d97706" : "#16a34a"

  const handleNavigate = (_txHash: string) => {
    // In a real app, this would scroll to / navigate to the active tx
  }

  return (
    <div className="nonce-conflict-row" style={{ borderLeftColor: conflict.hasConflict ? severityColor : undefined }}>
      <div className="nonce-conflict-header" onClick={() => setExpanded(!expanded)}>
        <div className="nonce-conflict-title">
          <span className="nonce-conflict-nonce">Nonce: {conflict.nonce}</span>
          <span className="nonce-conflict-count">{conflict.transactions.length} transaction{conflict.transactions.length !== 1 ? "s" : ""}</span>
          {conflict.hasConflict && (
            <span className="nonce-conflict-badge" style={{ background: severityColor }}>
              {severity.toUpperCase()}
            </span>
          )}
        </div>
        {conflict.active && (
          <div className="nonce-conflict-active-label">
            Active: <span className="mono">{shortHash(conflict.active.txHash)}</span>
          </div>
        )}
      </div>

      {expanded && (
        <div className="nonce-conflict-body">
          {/* Invalidation warnings */}
          {conflict.transactions
            .filter((tx) => tx.state === "superseded" || tx.state === "replaced")
            .map((tx) => {
              const warning = getInvalidationWarning(tx, conflict.active)
              return warning ? (
                <div key={tx.txHash} className="nonce-invalidation-warning">
                  ⚠️ {warning}
                </div>
              ) : null
            })}

          {/* Transaction list */}
          <div className="nonce-tx-list">
            {conflict.transactions.map((tx) => (
              <TxRow
                key={tx.txHash}
                tx={tx}
                isActive={conflict.active?.txHash === tx.txHash}
                onNavigate={handleNavigate}
              />
            ))}
          </div>

          {/* Conflict explanation */}
          {conflict.hasConflict && (
            <div className="nonce-conflict-explanation">
              <p>
                {conflict.transactions.length} transactions compete for nonce {conflict.nonce}.{" "}
                {conflict.active
                  ? `Transaction ${shortHash(conflict.active.txHash)} is the active transaction.`
                  : "No active transaction identified for this nonce."}{" "}
                Superseded transactions should not be used for security decisions.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TRANSACTIONS: NonceTransaction[] = [
  {
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    nonce: 42,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    state: "superseded",
    risk: "low",
    description: "Transfer 100 USDC to multisig",
    timestamp: Date.now() / 1000 - 600,
  },
  {
    txHash: "0xbbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999",
    nonce: 42,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    state: "replaced",
    risk: "high",
    description: "Transfer 50000 USDC to attacker",
    timestamp: Date.now() / 1000 - 300,
  },
  {
    txHash: "0xcccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000",
    nonce: 42,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    state: "active",
    risk: "medium",
    description: "Transfer 200 USDC to multisig (replacement)",
    timestamp: Date.now() / 1000 - 60,
  },
  {
    txHash: "0xdddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000eeee1111",
    nonce: 43,
    from: "0xdead000000000000000000000000000000000001",
    to: "0x1111000000000000000000000000000000000099",
    state: "confirmed",
    risk: "low",
    description: "Approve USDC spending",
    timestamp: Date.now() / 1000 - 120,
    blockNumber: 18000000,
  },
]

// ─── Main component ──────────────────────────────────────────────────

export function NonceConflictCard() {
  const [demoMode, setDemoMode] = useState(false)

  const transactions: NonceTransaction[] = demoMode ? DEMO_TRANSACTIONS : []
  const conflicts = detectNonceConflicts(transactions)
  const conflictCount = conflicts.filter((c) => c.hasConflict).length

  return (
    <section className="card nonce-card">
      <h2>Nonce conflict detection</h2>
      <p className="nonce-description">
        Detects when multiple transactions compete for the same execution position (nonce).
        Superseded transactions are invalidated and cannot appear as the active action.
      </p>

      <div className="nonce-controls">
        <button type="button" className={demoMode ? "nonce-demo-active" : ""} onClick={() => setDemoMode(!demoMode)}>
          {demoMode ? "Using demo data" : "Load demo data"}
        </button>
      </div>

      {!demoMode && (
        <p className="nonce-hint">
          Transaction nonce tracking activates when pending Safe transactions are detected. Click "Load demo data" to see a sample conflict.
        </p>
      )}

      {conflicts.length > 0 ? (
        <>
          {conflictCount > 0 && (
            <div className="nonce-summary">
              <span className="nonce-summary-badge">⚠ EXECUTION CONFLICT</span>
              <span className="nonce-summary-text">
                {conflictCount} nonce conflict{conflictCount !== 1 ? "s" : ""} detected across {transactions.length} transaction{transactions.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}

          <div className="nonce-conflict-list">
            {conflicts.map((conflict) => (
              <ConflictRow key={conflict.nonce} conflict={conflict} />
            ))}
          </div>
        </>
      ) : transactions.length > 0 ? (
        <div className="nonce-empty">
          <p>No nonce conflicts detected. All transactions occupy unique execution positions.</p>
        </div>
      ) : (
        <div className="nonce-empty">
          <p>No transactions to analyze.</p>
        </div>
      )}
    </section>
  )
}
