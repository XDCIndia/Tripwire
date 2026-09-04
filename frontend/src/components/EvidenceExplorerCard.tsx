import { useState } from "react"
import {
  type RiskSignal,
  type RiskEvidence,
  type VerdictWithEvidence,
  createEvidence,
  createSignal,
  createVerdict,
  getTotalEvidenceCount,
} from "../evidenceExplorer.js"

/**
 * Issue #85: Risk Signal Evidence Explorer UI
 *
 * Interactive drill-down from final verdict to individual evidence.
 * Every risk signal is expandable with source, value, threshold, and
 * confidence details.
 */

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "#dc2626"
    case "high":
      return "#ea580c"
    case "medium":
      return "#d97706"
    default:
      return "#16a34a"
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case "critical":
      return "🔴"
    case "high":
      return "🟠"
    case "medium":
      return "🟡"
    default:
      return "🟢"
  }
}

function riskColor(risk: string): string {
  switch (risk) {
    case "critical":
      return "#dc2626"
    case "high":
      return "#ea580c"
    case "medium":
      return "#d97706"
    default:
      return "#16a34a"
  }
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

// ─── Evidence panel ──────────────────────────────────────────────────

function EvidencePanel({ evidence }: { evidence: RiskEvidence }) {
  return (
    <div className={`evidence-panel ${evidence.verified ? "" : "evidence-unverified"}`}>
      <div className="evidence-header">
        <span className="evidence-source">{evidence.source}</span>
        {!evidence.verified && <span className="evidence-unverified-badge">UNVERIFIED</span>}
        <span className="evidence-confidence">
          {Math.round(evidence.confidence * 100)}% confidence
        </span>
      </div>
      <p className="evidence-observation">{evidence.observation}</p>
      <div className="evidence-values">
        <div className="evidence-value-row">
          <span className="evidence-label">Observed</span>
          <span className="evidence-val mono">{evidence.observedValue}</span>
        </div>
        {evidence.threshold && (
          <div className="evidence-value-row">
            <span className="evidence-label">Threshold</span>
            <span className="evidence-val mono">{evidence.threshold}</span>
          </div>
        )}
        {evidence.relatedField && (
          <div className="evidence-value-row">
            <span className="evidence-label">Related field</span>
            <span className="evidence-val">{evidence.relatedField}</span>
          </div>
        )}
        <div className="evidence-value-row">
          <span className="evidence-label">Timestamp</span>
          <span className="evidence-val">{new Date(evidence.timestamp).toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Signal row ──────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: RiskSignal }) {
  const [expanded, setExpanded] = useState(false)
  const color = severityColor(signal.severity)

  return (
    <div className="signal-row" style={{ borderLeftColor: color }}>
      <div className="signal-header" onClick={() => setExpanded(!expanded)}>
        <span className="signal-severity" style={{ color }}>
          {severityEmoji(signal.severity)} {signal.severity.toUpperCase()}
        </span>
        <span className="signal-name">{signal.name}</span>
        <span className="signal-weight">Weight: {signal.weight}</span>
        <span className="signal-expand">{expanded ? "▾" : "▸"}</span>
      </div>

      <p className="signal-explanation">{signal.explanation}</p>

      {expanded && (
        <div className="signal-evidence-list">
          {signal.evidence.length > 0 ? (
            signal.evidence.map((ev, i) => <EvidencePanel key={i} evidence={ev} />)
          ) : (
            <div className="evidence-missing">
              <p>No evidence available for this signal.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX_HASH = "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888"

function createDemoVerdict(): VerdictWithEvidence {
  const signals = [
    createSignal(
      "Unlimited Approval",
      "critical",
      [
        createEvidence("rule_engine", "approve() called with type(uint256).max as amount", "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", DEMO_TX_HASH, {
          threshold: "type(uint256).max",
          relatedField: "calldata",
          confidence: 1.0,
          verified: true,
        }),
        createEvidence("simulator", "Simulation confirmed allowance changed from 0 to unlimited", "0 → unlimited", DEMO_TX_HASH, {
          confidence: 0.95,
          verified: true,
        }),
      ],
      DEMO_TX_HASH,
      45,
      "Unlimited token approval grants the spender unrestricted spending permission. This is the most common vector in token-draining attacks.",
    ),
    createSignal(
      "First-Seen Counterparty",
      "high",
      [
        createEvidence("blacklist", "GoPlus Security: address not found in known-contract database", "unknown", DEMO_TX_HASH, {
          confidence: 0.7,
          verified: true,
          relatedField: "to",
        }),
      ],
      DEMO_TX_HASH,
      20,
      "This wallet has never sent a transaction to this counterparty before. Unknown counterparties carry higher risk.",
    ),
    createSignal(
      "Abnormal Amount",
      "medium",
      [
        createEvidence("rule_engine", "Transaction value exceeds wallet's historical p95 by 3.2x", "value: 10 ETH, p95: 3.1 ETH", DEMO_TX_HASH, {
          threshold: "p95: 3.1 ETH",
          confidence: 0.85,
          verified: true,
          relatedField: "value",
        }),
      ],
      DEMO_TX_HASH,
      15,
      "The transaction value is significantly higher than this wallet's typical spending pattern.",
    ),
    createSignal(
      "Contract Interaction",
      "low",
      [
        createEvidence("rule_engine", "Target is a verified contract with known function signatures", "verified: yes", DEMO_TX_HASH, {
          confidence: 0.9,
          verified: true,
          relatedField: "to",
        }),
      ],
      DEMO_TX_HASH,
      5,
      "The target contract is verified and has known function signatures. Low risk on its own.",
    ),
  ]

  return createVerdict(
    DEMO_TX_HASH,
    signals,
    "Critical risk: unlimited approval to first-seen counterparty with abnormal value.",
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function EvidenceExplorerCard() {
  const [demoMode, setDemoMode] = useState(false)
  const [expandedAll, setExpandedAll] = useState(false)

  const verdict: VerdictWithEvidence | null = demoMode ? createDemoVerdict() : null

  return (
    <section className="card evidence-card">
      <h2>Evidence explorer</h2>
      <p className="evidence-description">
        Drill from a risk verdict down to the individual evidence responsible for each signal.
        Every risk signal is inspectable without overwhelming the transaction view.
      </p>

      <div className="evidence-controls">
        <button type="button" className={demoMode ? "evidence-demo-active" : ""} onClick={() => setDemoMode(!demoMode)}>
          {demoMode ? "Using demo data" : "Load demo verdict"}
        </button>
        {verdict && (
          <button type="button" onClick={() => setExpandedAll(!expandedAll)}>
            {expandedAll ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {!demoMode && (
        <p className="evidence-hint">
          Evidence explorer activates when risk verdicts are available. Click "Load demo verdict" to see a sample.
        </p>
      )}

      {verdict && (
        <>
          {/* Verdict header */}
          <div className="evidence-verdict" style={{ borderColor: riskColor(verdict.riskLevel) }}>
            <div className="evidence-verdict-header">
              <span className="evidence-verdict-badge" style={{ background: riskColor(verdict.riskLevel) }}>
                {verdict.riskLevel.toUpperCase()}
              </span>
              <span className="evidence-verdict-score">{verdict.score}/100</span>
              <span className="evidence-verdict-action">{verdict.action.toUpperCase()}</span>
            </div>
            <p className="evidence-verdict-summary">{verdict.summary}</p>
            <div className="evidence-verdict-meta">
              <span>Signals: {verdict.signals.length}</span>
              <span>Evidence: {getTotalEvidenceCount(verdict)}</span>
              <span>Tx: {shortHash(verdict.txHash)}</span>
            </div>
          </div>

          {/* Signal tree */}
          <div className="evidence-signals">
            <h3>Risk signals</h3>
            {verdict.signals
              .sort((a, b) => {
                const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
                return (order[a.severity] ?? 4) - (order[b.severity] ?? 4)
              })
              .map((signal) => (
                <SignalRow key={signal.id} signal={signal} />
              ))}
          </div>
        </>
      )}

      {!verdict && !demoMode && (
        <div className="evidence-empty">
          <p>No verdict to explore.</p>
        </div>
      )}
    </section>
  )
}
