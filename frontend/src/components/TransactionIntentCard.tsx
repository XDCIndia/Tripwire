import { useState } from "react"
import {
  type TransactionIntent,
  type RiskIndicator,
  createDemoIntents,
  intentTypeLabel,
  intentTypeColor,
  riskIndicatorLabel,
  riskIndicatorColor,
} from "../transactionIntentDecoder.js"

/**
 * Issue #81: Transaction Intent Decoder & Human-Readable Security Preview
 *
 * Converts raw calldata into a human-readable description of what the
 * transaction will actually do, with security warnings and risk indicators.
 */

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash
}

// ─── Risk indicator badge ────────────────────────────────────────────

function RiskBadge({ indicator }: { indicator: RiskIndicator }) {
  const color = riskIndicatorColor(indicator)
  return (
    <span className="intent-risk-badge" style={{ borderColor: color, color }}>
      {riskIndicatorLabel(indicator)}
    </span>
  )
}

// ─── Warning message ─────────────────────────────────────────────────

function WarningBox({ warnings, severity }: { warnings: string[]; severity: "danger" | "caution" }) {
  if (warnings.length === 0) return null
  const icon = severity === "danger" ? "🚨" : "⚠️"
  const cls = severity === "danger" ? "intent-warning-danger" : "intent-warning-caution"
  return (
    <div className={`intent-warning ${cls}`}>
      <span className="intent-warning-icon">{icon}</span>
      <div className="intent-warning-text">
        {warnings.map((w, i) => <p key={i}>{w}</p>)}
      </div>
    </div>
  )
}

// ─── Parameter row ───────────────────────────────────────────────────

function ParamRow({ name, value, humanReadable }: { name: string; value: string; humanReadable?: string }) {
  return (
    <div className="intent-param">
      <span className="intent-param-name">{name}</span>
      <span className="intent-param-value mono" title={value}>
        {humanReadable ?? shortAddr(value)}
      </span>
    </div>
  )
}

// ─── Intent detail sections ──────────────────────────────────────────

function TransferDetail({ intent }: { intent: TransactionIntent }) {
  return (
    <div className="intent-detail">
      {intent.tokenSymbol && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Token</span>
          <span className="intent-detail-value">{intent.tokenSymbol}</span>
        </div>
      )}
      {intent.recipientAddress && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">To</span>
          <span className="intent-detail-value mono">{shortAddr(intent.recipientAddress)}</span>
        </div>
      )}
      {intent.amount && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Amount</span>
          <span className="intent-detail-value mono">{intent.amount} {intent.tokenSymbol ?? ""}</span>
        </div>
      )}
    </div>
  )
}

function ApprovalDetail({ intent }: { intent: TransactionIntent }) {
  return (
    <div className="intent-detail">
      {intent.tokenSymbol && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Token</span>
          <span className="intent-detail-value">{intent.tokenSymbol}</span>
        </div>
      )}
      {intent.spenderAddress && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Spender</span>
          <span className="intent-detail-value mono">{shortAddr(intent.spenderAddress)}</span>
        </div>
      )}
      <div className="intent-detail-row">
        <span className="intent-detail-label">Allowance</span>
        <span className={`intent-detail-value ${intent.isUnlimited ? "intent-unlimited" : ""}`}>
          {intent.isUnlimited ? "UNLIMITED" : (intent.amount ?? "—")}
        </span>
      </div>
    </div>
  )
}

function OperatorDetail({ intent }: { intent: TransactionIntent }) {
  return (
    <div className="intent-detail">
      {intent.operatorAddress && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Operator</span>
          <span className="intent-detail-value mono">{shortAddr(intent.operatorAddress)}</span>
        </div>
      )}
      {intent.collectionAddress && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Collection</span>
          <span className="intent-detail-value mono">{shortAddr(intent.collectionAddress)}</span>
        </div>
      )}
      {intent.tokenSymbol && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Collection</span>
          <span className="intent-detail-value">{intent.tokenSymbol}</span>
        </div>
      )}
    </div>
  )
}

function PermitDetail({ intent }: { intent: TransactionIntent }) {
  return (
    <div className="intent-detail">
      {intent.tokenSymbol && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Token</span>
          <span className="intent-detail-value">{intent.tokenSymbol}</span>
        </div>
      )}
      {intent.spenderAddress && (
        <div className="intent-detail-row">
          <span className="intent-detail-label">Spender</span>
          <span className="intent-detail-value mono">{shortAddr(intent.spenderAddress)}</span>
        </div>
      )}
      <div className="intent-detail-row">
        <span className="intent-detail-label">Allowance</span>
        <span className={`intent-detail-value ${intent.isUnlimited ? "intent-unlimited" : ""}`}>
          {intent.isUnlimited ? "UNLIMITED" : (intent.amount ?? "—")}
        </span>
      </div>
    </div>
  )
}

// ─── Single intent card ──────────────────────────────────────────────

function IntentDisplay({ intent }: { intent: TransactionIntent }) {
  const typeColor = intentTypeColor(intent.type)
  const hasDanger = intent.riskIndicators.some((r) => r === "unlimited_approval" || r === "operator_approval")

  return (
    <div className={`intent-entry ${intent.decoded ? "" : "intent-entry-unknown"}`}>
      {/* Type badge */}
      <div className="intent-type-header">
        <span className="intent-type-badge" style={{ borderColor: typeColor, color: typeColor }}>
          {intentTypeLabel(intent.type)}
        </span>
        <span className="intent-hash mono">{shortHash(intent.txHash)}</span>
      </div>

      {/* Intent summary */}
      <h3 className="intent-summary">{intent.intentSummary}</h3>

      {/* Detail section */}
      {intent.type === "transfer" && <TransferDetail intent={intent} />}
      {intent.type === "approval" && <ApprovalDetail intent={intent} />}
      {intent.type === "operator_approval" && <OperatorDetail intent={intent} />}
      {intent.type === "permit" && <PermitDetail intent={intent} />}
      {intent.type === "native_transfer" && <TransferDetail intent={intent} />}

      {/* Risk indicators */}
      {intent.riskIndicators.length > 0 && (
        <div className="intent-risk-badges">
          {intent.riskIndicators.map((r) => <RiskBadge key={r} indicator={r} />)}
        </div>
      )}

      {/* Warnings */}
      <WarningBox
        warnings={intent.warnings}
        severity={hasDanger ? "danger" : "caution"}
      />

      {/* Unknown state notice */}
      {!intent.decoded && (
        <div className="intent-unknown-notice">
          <p>Security preview unavailable. Do not interpret this transaction as safe.</p>
        </div>
      )}

      {/* Decoded parameters (collapsed) */}
      {intent.parameters.length > 0 && (
        <details className="intent-params">
          <summary>Decoded parameters</summary>
          {intent.parameters.map((p) => (
            <ParamRow key={p.name} name={p.name} value={p.value} humanReadable={p.humanReadable} />
          ))}
        </details>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function TransactionIntentCard() {
  const [demoMode, setDemoMode] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const intents = demoMode ? createDemoIntents() : []
  const selected = intents[selectedIndex] ?? null

  return (
    <section className="card intent-card">
      <h2>Transaction intent</h2>
      <p className="intent-description">
        Human-readable preview of what a transaction will actually do before execution.
        Decoded from raw calldata — never fabricated.
      </p>

      <div className="intent-controls">
        <button
          type="button"
          className={demoMode ? "intent-btn-active" : ""}
          onClick={() => { setDemoMode(!demoMode); setSelectedIndex(0) }}
        >
          {demoMode ? "Using demo data" : "Load demo intents"}
        </button>
      </div>

      {!demoMode && (
        <p className="intent-hint">
          Intent decoder activates when transactions are proposed. Click "Load demo intents" to see samples.
        </p>
      )}

      {demoMode && intents.length > 0 && (
        <>
          {/* Intent selector tabs */}
          <div className="intent-tabs">
            {intents.map((intent, i) => (
              <button
                key={i}
                type="button"
                className={`intent-tab ${i === selectedIndex ? "intent-tab-active" : ""} ${
                  !intent.decoded ? "intent-tab-unknown" : ""
                }`}
                style={i === selectedIndex ? { borderColor: intentTypeColor(intent.type) } : undefined}
                onClick={() => setSelectedIndex(i)}
              >
                {intentTypeLabel(intent.type)}
                {intent.riskIndicators.length > 0 && (
                  <span className="intent-tab-count">{intent.riskIndicators.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Selected intent */}
          {selected && <IntentDisplay intent={selected} />}
        </>
      )}

      {!demoMode && (
        <div className="intent-empty">
          <p>No transaction to decode.</p>
        </div>
      )}
    </section>
  )
}
