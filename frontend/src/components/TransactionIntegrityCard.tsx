import { useState } from "react"
import {
  type IntegrityCheck,
  type IntegrityStatus,
  checkIntegrityDetailed,
  createDemoVerdict,
  createDemoMismatch,
  DEMO_TX,
  shortenFingerprint,
  statusLabel,
  statusColor,
} from "../transactionIntegrity.js"

/**
 * Issue #83: Transaction Integrity Fingerprinting & Tamper Detection UI
 *
 * Displays integrity status for the current transaction/verdict pair.
 * Verified when fingerprints match, UNVERIFIED when no verdict exists,
 * MISMATCH with warning when they diverge.
 */

// ─── Demo modes ──────────────────────────────────────────────────────

type DemoMode = "none" | "verified" | "mismatch" | "unverified"

function getDemoCheck(mode: DemoMode): IntegrityCheck | null {
  switch (mode) {
    case "verified": {
      const verdict = createDemoVerdict()
      return checkIntegrityDetailed(DEMO_TX, verdict, DEMO_TX)
    }
    case "mismatch": {
      const { transaction, verdict, verdictTransaction } = createDemoMismatch()
      return checkIntegrityDetailed(transaction, verdict, verdictTransaction)
    }
    case "unverified":
      return checkIntegrityDetailed(DEMO_TX, null)
    default:
      return null
  }
}

// ─── Status indicator ────────────────────────────────────────────────

function StatusDot({ status }: { status: IntegrityStatus }) {
  const color = statusColor(status)
  return (
    <span
      className="integrity-dot"
      style={{ background: color }}
      aria-label={statusLabel(status)}
    />
  )
}

// ─── Mismatch details ────────────────────────────────────────────────

function MismatchWarning({ check }: { check: IntegrityCheck }) {
  return (
    <div className="integrity-mismatch">
      <div className="integrity-mismatch-header">
        <span className="integrity-mismatch-icon">⚠️</span>
        <span className="integrity-mismatch-title">TRANSACTION INTEGRITY ERROR</span>
      </div>
      <p className="integrity-mismatch-text">
        The displayed transaction does not match the transaction used for this risk verdict.
        Security verdict invalidated.
      </p>
      <div className="integrity-mismatch-fingerprints">
        <div className="integrity-fp-row">
          <span className="integrity-fp-label">Expected:</span>
          <span className="integrity-fp-value mono">{shortenFingerprint(check.verdictFingerprint ?? "—")}</span>
        </div>
        <div className="integrity-fp-row">
          <span className="integrity-fp-label">Current:</span>
          <span className="integrity-fp-value mono">{shortenFingerprint(check.currentFingerprint)}</span>
        </div>
      </div>
      {check.mismatchedFields.length > 0 && check.mismatchedFields[0] !== "fingerprint_mismatch" && (
        <div className="integrity-mismatch-fields">
          <span className="integrity-mismatch-fields-label">Changed fields:</span>
          <div className="integrity-mismatch-fields-list">
            {check.mismatchedFields.map((field) => (
              <span key={field} className="integrity-field-badge">{field}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Field display ───────────────────────────────────────────────────

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="integrity-field">
      <span className="integrity-field-label">{label}</span>
      <span className="integrity-field-value mono">{value}</span>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function TransactionIntegrityCard() {
  const [demoMode, setDemoMode] = useState<DemoMode>("none")
  const check: IntegrityCheck | null = getDemoCheck(demoMode)

  return (
    <section className="card integrity-card">
      <h2>Transaction integrity</h2>
      <p className="integrity-description">
        Validates that displayed risk verdicts match the exact transaction they were generated for.
      </p>

      <div className="integrity-controls">
        <button
          type="button"
          className={demoMode === "verified" ? "integrity-btn-active" : ""}
          onClick={() => setDemoMode(demoMode === "verified" ? "none" : "verified")}
        >
          Verified
        </button>
        <button
          type="button"
          className={demoMode === "mismatch" ? "integrity-btn-active integrity-btn-mismatch" : ""}
          onClick={() => setDemoMode(demoMode === "mismatch" ? "none" : "mismatch")}
        >
          Mismatch
        </button>
        <button
          type="button"
          className={demoMode === "unverified" ? "integrity-btn-active integrity-btn-unverified" : ""}
          onClick={() => setDemoMode(demoMode === "unverified" ? "none" : "unverified")}
        >
          Unverified
        </button>
      </div>

      {!check && (
        <p className="integrity-hint">
          Select a demo mode to see integrity verification in action.
        </p>
      )}

      {check && (
        <>
          {/* Integrity status header */}
          <div
            className="integrity-status"
            style={{ borderColor: statusColor(check.status) }}
          >
            <div className="integrity-status-row">
              <StatusDot status={check.status} />
              <span className="integrity-status-label" style={{ color: statusColor(check.status) }}>
                {statusLabel(check.status)}
              </span>
              <span className="integrity-status-time">
                {new Date(check.checkedAt).toLocaleTimeString()}
              </span>
            </div>
          </div>

          {/* Transaction details */}
          <div className="integrity-details">
            <h3>Transaction</h3>
            <FieldRow label="Tx Hash" value={shortenFingerprint(check.transaction.txHash)} />
            <FieldRow label="Chain" value={check.transaction.chainId.toString()} />
            <FieldRow label="Safe" value={shortenFingerprint(check.transaction.safeAddress)} />
            <FieldRow label="Target" value={shortenFingerprint(check.transaction.targetAddress)} />
            <FieldRow label="Value" value={check.transaction.value} />
            <FieldRow label="Calldata" value={`${check.transaction.calldata.slice(0, 18)}…`} />
            {check.transaction.nonce !== undefined && (
              <FieldRow label="Nonce" value={check.transaction.nonce.toString()} />
            )}
          </div>

          {/* Fingerprint */}
          <div className="integrity-fingerprint">
            <h3>Fingerprint</h3>
            <div className="integrity-fp-display mono">
              {shortenFingerprint(check.currentFingerprint)}
            </div>
          </div>

          {/* Verdict binding */}
          {check.verdict && (
            <div className="integrity-verdict">
              <h3>Risk verdict</h3>
              <div className="integrity-verdict-row">
                <span className={`integrity-verdict-badge integrity-verdict-${check.verdict.verdict}`}>
                  {check.verdict.verdict.toUpperCase()}
                </span>
                <span className="integrity-verdict-score">{check.verdict.score}/100</span>
                <span className="integrity-verdict-version">Verdict {check.verdict.verdictVersion}</span>
              </div>
              <div className="integrity-verdict-fp">
                <span className="integrity-verdict-fp-label">Bound fingerprint:</span>
                <span className="mono">{shortenFingerprint(check.verdict.transactionFingerprint)}</span>
              </div>
            </div>
          )}

          {/* Mismatch warning */}
          {check.status === "mismatch" && <MismatchWarning check={check} />}
        </>
      )}
    </section>
  )
}
