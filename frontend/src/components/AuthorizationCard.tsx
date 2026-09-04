import { useState } from "react"
import {
  type AuthorizationSnapshot,
  type TransactionSnapshot,
  type DriftResult,
  createAuthorization,
  checkAuthorization,
} from "../authorizationTracker.js"

/**
 * Issue #96: Execution Authorization Drift Detection UI
 *
 * Shows whether the transaction being executed matches the one that was
 * reviewed and authorized. Invalidates authorization when any security-
 * critical field changes.
 */

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function statusColor(status: string): string {
  switch (status) {
    case "valid":
      return "#16a34a"
    case "invalid":
      return "#dc2626"
    default:
      return "#6b7280"
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "valid":
      return "✓"
    case "invalid":
      return "⚠"
    default:
      return "?"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_REVIEWED: TransactionSnapshot = {
  target: "0xbeef000000000000000000000000000000000002",
  value: "100000000000000000",
  calldata: "0xa9059cbb000000000000000000000000dead0000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000f4240",
  nonce: 42,
  chainId: 11155111,
  safeAddress: "0xaaaa000000000000000000000000000000000001",
}

const DEMO_DRIFTED: TransactionSnapshot = {
  target: "0x1111000000000000000000000000000000000099", // changed!
  value: "500000000000000000", // changed!
  calldata: "0xa9059cbb000000000000000000000000dead0000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000f4240",
  nonce: 42,
  chainId: 11155111,
  safeAddress: "0xaaaa000000000000000000000000000000000001",
}

// ─── Main component ──────────────────────────────────────────────────

export function AuthorizationCard() {
  const [demoMode, setDemoMode] = useState<"none" | "valid" | "drifted">("none")
  const [auth, setAuth] = useState<AuthorizationSnapshot | null>(null)
  const [current, setCurrent] = useState<TransactionSnapshot>(DEMO_REVIEWED)

  // Run drift check
  const drift: DriftResult = checkAuthorization(auth, current)

  function handleAuthorize() {
    const snapshot = createAuthorization(
      current,
      { score: 25, label: "low_risk", action: "allow" },
      "0xdead000000000000000000000000000000000001",
    )
    setAuth(snapshot)
  }

  function handleDemoValid() {
    setDemoMode("valid")
    setCurrent(DEMO_REVIEWED)
    const snapshot = createAuthorization(
      DEMO_REVIEWED,
      { score: 25, label: "low_risk", action: "allow" },
      "0xdead000000000000000000000000000000000001",
    )
    setAuth(snapshot)
  }

  function handleDemoDrifted() {
    setDemoMode("drifted")
    setCurrent(DEMO_DRIFTED)
    // Auth was created against the reviewed version
    const snapshot = createAuthorization(
      DEMO_REVIEWED,
      { score: 25, label: "low_risk", action: "allow" },
      "0xdead000000000000000000000000000000000001",
    )
    setAuth(snapshot)
  }

  function handleReset() {
    setDemoMode("none")
    setAuth(null)
    setCurrent(DEMO_REVIEWED)
  }

  return (
    <section className="card auth-card">
      <h2>Execution authorization</h2>
      <p className="auth-description">
        Ensures the transaction being executed is exactly the one that was reviewed and authorized.
        Any security-critical change invalidates the authorization.
      </p>

      <div className="auth-controls">
        <button type="button" className={demoMode === "valid" ? "auth-demo-active" : ""} onClick={handleDemoValid}>
          Demo: valid
        </button>
        <button type="button" className={demoMode === "drifted" ? "auth-demo-drifted" : ""} onClick={handleDemoDrifted}>
          Demo: drift detected
        </button>
        <button type="button" onClick={handleReset}>Reset</button>
      </div>

      {/* Authorization status */}
      <div className="auth-status" style={{ borderColor: statusColor(drift.status) }}>
        <div className="auth-status-header">
          <span className="auth-status-badge" style={{ background: statusColor(drift.status) }}>
            {statusIcon(drift.status)} {drift.status === "valid" ? "AUTHORIZED" : drift.status === "invalid" ? "AUTHORIZATION INVALID" : "NO AUTHORIZATION"}
          </span>
        </div>
        <p className="auth-summary">{drift.summary}</p>
      </div>

      {/* Field comparison table */}
      {auth && (
        <div className="auth-fields">
          <h3>Field comparison</h3>
          <table className="auth-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Reviewed</th>
                <th>Current</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {drift.fieldDetails.map((fd) => (
                <tr key={fd.field} className={fd.matches ? "" : "auth-row-changed"}>
                  <td className="auth-field-name">{fd.field}</td>
                  <td className="mono auth-field-val">{fd.field === "calldata" ? `${fd.reviewed.slice(0, 18)}…` : fd.field === "target" || fd.field === "safe" ? shortAddr(fd.reviewed) : fd.reviewed}</td>
                  <td className="mono auth-field-val">{fd.field === "calldata" ? `${fd.current.slice(0, 18)}…` : fd.field === "target" || fd.field === "safe" ? shortAddr(fd.current) : fd.current}</td>
                  <td>
                    <span className={fd.matches ? "auth-match" : "auth-mismatch"}>
                      {fd.matches ? "✓ Match" : "✕ Changed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Changed fields detail */}
      {drift.status === "invalid" && drift.changedFields.length > 0 && (
        <div className="auth-drift-detail">
          <h3>Changed fields</h3>
          {drift.fieldDetails
            .filter((fd) => !fd.matches)
            .map((fd) => (
              <div key={fd.field} className="auth-drift-field">
                <span className="auth-drift-label">{fd.field}</span>
                <div className="auth-drift-values">
                  <div className="auth-drift-reviewed">
                    <span className="auth-drift-sublabel">Reviewed:</span>
                    <span className="mono">{fd.field === "calldata" ? `${fd.reviewed.slice(0, 24)}…` : fd.reviewed}</span>
                  </div>
                  <div className="auth-drift-current">
                    <span className="auth-drift-sublabel">Current:</span>
                    <span className="mono">{fd.field === "calldata" ? `${fd.current.slice(0, 24)}…` : fd.current}</span>
                  </div>
                </div>
              </div>
            ))}
          <p className="auth-drift-warning">
            The previous security decision cannot be reused. Re-review the updated transaction.
          </p>
        </div>
      )}

      {/* Authorization info */}
      {auth && drift.status === "valid" && (
        <div className="auth-info">
          <dl className="auth-info-list">
            <dt>Authorized at</dt>
            <dd>{new Date(auth.authorizedAt).toLocaleString()}</dd>
            <dt>Authorized by</dt>
            <dd className="mono">{shortAddr(auth.authorizedBy)}</dd>
            <dt>Risk decision</dt>
            <dd>{auth.riskDecision.label} ({auth.riskDecision.action})</dd>
          </dl>
        </div>
      )}

      {/* Manual authorize button (for demo without auto-mode) */}
      {demoMode === "none" && !auth && (
        <button type="button" className="auth-authorize-btn" onClick={handleAuthorize}>
          Authorize current transaction
        </button>
      )}
    </section>
  )
}
