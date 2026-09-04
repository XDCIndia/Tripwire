import { useState } from "react"
import {
  type InternalCall,
  type CallRisk,
  type BatchRiskAnalysis,
  analyzeBatch,
  formatFunction,
} from "../batchRiskAnalyzer.js"

/**
 * Issue #89: Multi-Transaction Batch Risk Matrix & Aggregate Risk Analysis UI
 *
 * Analyzes Safe batch transactions containing multiple internal calls.
 * Displays risk at both individual call level and aggregate batch level.
 */

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
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

function decisionColor(decision: string): string {
  switch (decision) {
    case "block":
      return "#dc2626"
    case "hold":
      return "#d97706"
    default:
      return "#16a34a"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_CALLS: InternalCall[] = [
  {
    index: 0,
    target: "0xbeef000000000000000000000000000000000002",
    functionSignature: "transfer(address,uint256)",
    calldata: "0xa9059cbb",
    value: "0",
    asset: "ETH",
    amount: "0.01 ETH",
    counterparty: "0x1111000000000000000000000000000000000099",
    signals: [],
    explanation: "Standard ETH transfer to known address.",
  },
  {
    index: 1,
    target: "0xcccc000000000000000000000000000000000003",
    functionSignature: "swap(address,uint256)",
    calldata: "0x12345678",
    value: "0",
    asset: "USDC",
    amount: "500 USDC",
    counterparty: "0x2222000000000000000000000000000000000088",
    signals: ["unknown-contract-interaction"],
    explanation: "Interaction with unverified DEX contract.",
  },
  {
    index: 2,
    target: "0xtoken00000000000000000000000000000000000001",
    functionSignature: "approve(address,uint256)",
    calldata: "0x095ea7b3000000000000000000000000bbbb0000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064",
    value: "0",
    asset: "USDC",
    amount: "100 USDC",
    counterparty: "0xbbbb000000000000000000000000000000000002",
    signals: ["limited-approval"],
    explanation: "Limited approval for 100 USDC to known spender.",
  },
  {
    index: 3,
    target: "0xnft00000000000000000000000000000000000001",
    functionSignature: "setApprovalForAll(address,bool)",
    calldata: "0xa22cb465000000000000000000000000dddd000000000000000000000000000000000004",
    value: "0",
    asset: "NFT Collection",
    counterparty: "0xdddd000000000000000000000000000000000004",
    signals: ["blanket-operator-permission"],
    explanation: "Grants blanket operator permission over entire NFT collection to unknown address.",
  },
]

// ─── Call detail drawer ──────────────────────────────────────────────

function CallDetail({ risk }: { risk: CallRisk }) {
  const color = riskColor(risk.riskLevel)
  return (
    <div className="batch-detail">
      <dl className="batch-detail-list">
        <dt>Operation</dt>
        <dd>{risk.call.functionSignature}</dd>
        <dt>Target</dt>
        <dd className="mono">{shortAddr(risk.call.target)}</dd>
        {risk.call.asset && (
          <>
            <dt>Asset</dt>
            <dd>{risk.call.asset}</dd>
          </>
        )}
        {risk.call.amount && (
          <>
            <dt>Amount</dt>
            <dd>{risk.call.amount}</dd>
          </>
        )}
        <dt>Counterparty</dt>
        <dd className="mono">{shortAddr(risk.call.counterparty)}</dd>
        <dt>Risk Level</dt>
        <dd style={{ color }}>{risk.riskLevel.toUpperCase()}</dd>
        <dt>Risk Score</dt>
        <dd>
          <div className="batch-score-bar">
            <div className="batch-score-fill" style={{ width: `${risk.score}%`, background: color }} />
            <span className="batch-score-text">{risk.score}/100</span>
          </div>
        </dd>
      </dl>

      {risk.call.signals.length > 0 && (
        <div className="batch-signals">
          <h4>Risk Signals</h4>
          <ul>
            {risk.call.signals.map((s) => (
              <li key={s} className="batch-signal">{s.replace(/-/g, " ")}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="batch-explanation">
        <h4>Why this matters</h4>
        <p>{risk.call.explanation}</p>
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function BatchRiskCard() {
  const [demoMode, setDemoMode] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const calls: InternalCall[] = demoMode ? DEMO_CALLS : []
  const analysis: BatchRiskAnalysis | null = calls.length > 0 ? analyzeBatch("demo-batch-1", calls) : null

  return (
    <section className="card batch-card">
      <h2>Batch risk matrix</h2>
      <p className="batch-description">
        Analyzes Safe batch transactions with multiple internal calls. Shows per-call risk
        and aggregate batch risk so dangerous operations can't hide in a legitimate batch.
      </p>

      <div className="batch-controls">
        <button type="button" className={demoMode ? "batch-demo-active" : ""} onClick={() => setDemoMode(!demoMode)}>
          {demoMode ? "Using demo data" : "Load demo batch"}
        </button>
      </div>

      {!demoMode && (
        <p className="batch-hint">
          Batch analysis activates when multi-call Safe transactions are detected. Click "Load demo batch" to see a sample.
        </p>
      )}

      {analysis && (
        <>
          {/* Batch header */}
          <div className="batch-header" style={{ borderColor: decisionColor(analysis.decision) }}>
            <div className="batch-header-top">
              <span className="batch-header-id">Batch {analysis.batchId}</span>
              <span className="batch-header-count">{analysis.callCount} operations</span>
            </div>
            <div className="batch-header-risk">
              <span className="batch-risk-badge" style={{ background: riskColor(analysis.aggregateRisk) }}>
                {analysis.aggregateRisk.toUpperCase()}
              </span>
              <span className="batch-decision-badge" style={{ background: decisionColor(analysis.decision) }}>
                {analysis.decision.toUpperCase()}
              </span>
            </div>
            <div className="batch-breakdown">
              <span className="batch-breakdown-item batch-bl">{analysis.breakdown.low} low</span>
              <span className="batch-breakdown-item batch-bm">{analysis.breakdown.medium} medium</span>
              <span className="batch-breakdown-item batch-bh">{analysis.breakdown.high} high</span>
              <span className="batch-breakdown-item batch-bc">{analysis.breakdown.critical} critical</span>
            </div>
          </div>

          {/* Risk matrix table */}
          <div className="batch-matrix">
            <h3>Risk matrix</h3>
            <table className="batch-table">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Operation</th>
                  <th>Target</th>
                  <th>Risk</th>
                  <th>Contribution</th>
                </tr>
              </thead>
              <tbody>
                {analysis.callRisks.map((cr) => (
                  <tr
                    key={cr.call.index}
                    className={`batch-row ${selectedIdx === cr.call.index ? "batch-row-selected" : ""} ${cr.riskLevel === "critical" ? "batch-row-critical" : ""}`}
                    onClick={() => setSelectedIdx(selectedIdx === cr.call.index ? null : cr.call.index)}
                  >
                    <td className="batch-call-idx">#{cr.call.index + 1}</td>
                    <td>{formatFunction(cr.call.functionSignature)}</td>
                    <td className="mono">{shortAddr(cr.call.target)}</td>
                    <td>
                      <span className="batch-risk-tag" style={{ background: `${riskColor(cr.riskLevel)}20`, color: riskColor(cr.riskLevel), border: `1px solid ${riskColor(cr.riskLevel)}40` }}>
                        {cr.riskLevel.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <div className="batch-contrib-bar">
                        <div className="batch-contrib-fill" style={{ width: `${cr.score}%`, background: riskColor(cr.riskLevel) }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Call detail drawer */}
          {selectedIdx !== null && analysis.callRisks[selectedIdx] && (
            <CallDetail risk={analysis.callRisks[selectedIdx]} />
          )}

          {/* Aggregate decision */}
          <div className="batch-aggregate" style={{ borderColor: decisionColor(analysis.decision) }}>
            <h3>Batch decision</h3>
            <div className="batch-decision-row">
              <span className="batch-decision-level" style={{ color: riskColor(analysis.aggregateRisk) }}>
                {analysis.aggregateRisk.toUpperCase()} RISK
              </span>
              <span className="batch-decision-action" style={{ color: decisionColor(analysis.decision) }}>
                {analysis.decision.toUpperCase()}
              </span>
            </div>
            <p className="batch-summary">{analysis.summary}</p>
          </div>
        </>
      )}

      {!analysis && !demoMode && (
        <div className="batch-empty">
          <p>No batch transactions to analyze.</p>
        </div>
      )}
    </section>
  )
}
