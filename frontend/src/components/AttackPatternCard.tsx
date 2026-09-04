import { useState } from "react"
import {
  type DetectedPattern,
  type TxRecord,
  type PatternSeverity,
  calculateOverallSeverity,
  detectPatterns,
} from "../patternDetector.js"

/**
 * Issue #99: Cross-Transaction Attack Pattern Detection UI
 *
 * Groups related transactions into sequences, detects suspicious patterns,
 * and presents them with an attack chain visualization. Includes a demo
 * mode with sample data so the feature is demonstrable without a live feed.
 */

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

function severityColor(severity: PatternSeverity): string {
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

function severityEmoji(severity: PatternSeverity): string {
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

function operationLabel(op: string): string {
  switch (op) {
    case "approve":
      return "Approve"
    case "transfer":
      return "Transfer"
    case "transferFrom":
      return "Transfer From"
    case "setApprovalForAll":
      return "Set Approval For All"
    case "contractInteraction":
      return "Contract Interaction"
    default:
      return "Unknown"
  }
}

// ─── Attack chain node ───────────────────────────────────────────────

function AttackChainNode({
  tx,
  index,
  isLast,
  isSelected,
  onSelect,
}: {
  tx: TxRecord
  index: number
  isLast: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <div className="chain-node-wrap">
      <button
        type="button"
        className={`chain-node ${isSelected ? "chain-node-selected" : ""}`}
        onClick={onSelect}
      >
        <span className="chain-node-index">#{index + 1}</span>
        <span className="chain-node-op">{operationLabel(tx.operation)}</span>
        <span className="chain-node-hash mono">{shortHash(tx.txHash)}</span>
      </button>
      {!isLast && <div className="chain-arrow" aria-hidden="true">↓</div>}
      {isSelected && (
        <div className="chain-detail">
          <dl className="chain-detail-list">
            <dt>Hash</dt>
            <dd className="mono">{tx.txHash}</dd>
            <dt>Time</dt>
            <dd>{new Date(tx.timestamp * 1000).toLocaleString()}</dd>
            <dt>From</dt>
            <dd className="mono">{shortHash(tx.from)}</dd>
            <dt>To</dt>
            <dd className="mono">{shortHash(tx.to)}</dd>
            {tx.asset && (
              <>
                <dt>Asset</dt>
                <dd className="mono">{tx.asset}</dd>
              </>
            )}
            {tx.amount !== undefined && (
              <>
                <dt>Amount</dt>
                <dd>{tx.amount.toString()}</dd>
              </>
            )}
            {tx.risk && (
              <>
                <dt>Individual Risk</dt>
                <dd style={{ color: severityColor(tx.risk === "high" ? "high" : tx.risk === "medium" ? "medium" : "low") }}>
                  {tx.risk.toUpperCase()}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  )
}

// ─── Pattern card ────────────────────────────────────────────────────

function PatternRow({ pattern }: { pattern: DetectedPattern }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const color = severityColor(pattern.severity)

  return (
    <div className="pattern-row" style={{ borderLeftColor: color }}>
      <div className="pattern-header" onClick={() => setExpanded(!expanded)}>
        <div className="pattern-title-row">
          <span className="pattern-severity" style={{ color }}>
            {severityEmoji(pattern.severity)} {pattern.severity.toUpperCase()}
          </span>
          <span className="pattern-name">{pattern.name}</span>
          <span className="pattern-count">{pattern.transactions.length} txs</span>
        </div>
        <p className="pattern-desc">{pattern.description}</p>
        <button type="button" className="pattern-expand-btn">
          {expanded ? "Hide attack chain" : "View attack chain"}
        </button>
      </div>

      {expanded && (
        <div className="pattern-expanded">
          {/* Explanation */}
          <div className="pattern-explanation">
            <h4>Why this is suspicious</h4>
            <p>{pattern.explanation}</p>
          </div>

          {/* Signals */}
          <div className="pattern-signals">
            <h4>Detected signals</h4>
            <ul>
              {pattern.signals.map((s) => (
                <li key={s} className="pattern-signal">{s}</li>
              ))}
            </ul>
          </div>

          {/* Attack chain */}
          <div className="pattern-chain">
            <h4>Attack chain</h4>
            <div className="chain-visual">
              {pattern.transactions
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((tx, i) => (
                  <AttackChainNode
                    key={tx.txHash}
                    tx={tx}
                    index={i}
                    isLast={i === pattern.transactions.length - 1}
                    isSelected={selectedIdx === i}
                    onSelect={() => setSelectedIdx(selectedIdx === i ? null : i)}
                  />
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TRANSACTIONS: TxRecord[] = [
  {
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    timestamp: Date.now() / 1000 - 300,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    operation: "approve",
    asset: "USDC",
    amount: 1000n * 10n ** 6n,
    risk: "medium",
  },
  {
    txHash: "0xbbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999",
    timestamp: Date.now() / 1000 - 240,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    operation: "contractInteraction",
    asset: "USDC",
    risk: "medium",
  },
  {
    txHash: "0xcccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000",
    timestamp: Date.now() / 1000 - 180,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    operation: "approve",
    asset: "USDC",
    amount: 50000n * 10n ** 6n,
    risk: "high",
  },
  {
    txHash: "0xdddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000eeee1111",
    timestamp: Date.now() / 1000 - 60,
    from: "0xdead000000000000000000000000000000000001",
    to: "0xbeef000000000000000000000000000000000002",
    operation: "transfer",
    asset: "USDC",
    amount: 50000n * 10n ** 6n,
    risk: "high",
  },
]

// ─── Main component ──────────────────────────────────────────────────

export function AttackPatternCard() {
  const [demoMode, setDemoMode] = useState(false)

  // In demo mode, use sample data; otherwise empty
  const transactions: TxRecord[] = demoMode ? DEMO_TRANSACTIONS : []

  const patterns = detectPatterns(transactions)
  const overallSeverity = calculateOverallSeverity(patterns)

  return (
    <section className="card pattern-card">
      <h2>Attack pattern detection</h2>
      <p className="pattern-description">
        Detects suspicious patterns across multiple related transactions. Groups operations by
        wallet, asset, and counterparty to identify attack sequences.
      </p>

      <div className="pattern-controls">
        <button type="button" className={demoMode ? "pattern-demo-active" : ""} onClick={() => setDemoMode(!demoMode)}>
          {demoMode ? "Using demo data" : "Load demo data"}
        </button>
      </div>

      {!demoMode && (
        <p className="pattern-hint">
          Paste transaction data to analyze. Or click "Load demo data" to see a sample attack sequence.
        </p>
      )}

      {patterns.length > 0 ? (
        <>
          <div className="pattern-summary" style={{ borderColor: severityColor(overallSeverity) }}>
            <div className="pattern-summary-header">
              <span className="pattern-summary-badge" style={{ background: severityColor(overallSeverity) }}>
                {severityEmoji(overallSeverity)} SECURITY PATTERN DETECTED
              </span>
            </div>
            <div className="pattern-summary-stats">
              <span>{patterns.length} pattern{patterns.length !== 1 ? "s" : ""}</span>
              <span>{transactions.length} transaction{transactions.length !== 1 ? "s" : ""}</span>
              <span>Severity: {overallSeverity.toUpperCase()}</span>
            </div>
          </div>

          <div className="pattern-list">
            {patterns
              .sort((a, b) => {
                const order: Record<PatternSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
                return order[a.severity] - order[b.severity]
              })
              .map((pattern) => (
                <PatternRow key={pattern.id} pattern={pattern} />
              ))}
          </div>
        </>
      ) : transactions.length > 0 ? (
        <div className="pattern-empty">
          <p>No suspicious patterns detected across {transactions.length} transaction{transactions.length !== 1 ? "s" : ""}.</p>
        </div>
      ) : (
        <div className="pattern-empty">
          <p>No transactions to analyze.</p>
        </div>
      )}
    </section>
  )
}


