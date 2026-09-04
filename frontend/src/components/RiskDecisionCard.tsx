import { useState } from "react"
import {
  type RiskDecision,
  type RiskSignal,
  type TimelineEvent,
  createDemoDecision,
  verdictColor,
  verdictLabel,
  verdictEmoji,
  severityColor,
  severityLabel,
  statusColor,
  enforcementColor,
  sourceLabel,
  sourceColor,
  shortHash,
  shortAddr,
} from "../riskDecisionCenter.js"

/**
 * Issue #79: Frontend Risk Decision Center & Transaction Explainability UI
 *
 * Complete transaction-level view: intent → risk signals → simulation →
 * AI reasoning → verdict → enforcement. Every section exposes the
 * decision context without requiring backend log inspection.
 */

// ─── Section wrapper ─────────────────────────────────────────────────

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rdc-section">
      <div className="rdc-section-header" onClick={() => setOpen(!open)}>
        <span className="rdc-section-title">{title}</span>
        <span className="rdc-section-toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && <div className="rdc-section-body">{children}</div>}
    </div>
  )
}

// ─── Transaction header ──────────────────────────────────────────────

function TxHeader({ decision }: { decision: RiskDecision }) {
  const tx = decision.transaction
  return (
    <div className="rdc-tx-header">
      <div className="rdc-tx-row">
        <span className="rdc-tx-label">Tx Hash</span>
        <span className="rdc-tx-value mono">{shortHash(tx.txHash)}</span>
      </div>
      <div className="rdc-tx-row">
        <span className="rdc-tx-label">Safe</span>
        <span className="rdc-tx-value mono">{shortAddr(tx.safeAddress)}</span>
      </div>
      <div className="rdc-tx-row">
        <span className="rdc-tx-label">Chain</span>
        <span className="rdc-tx-value">{tx.chain}</span>
      </div>
      <div className="rdc-tx-row">
        <span className="rdc-tx-label">Destination</span>
        <span className="rdc-tx-value mono">{shortAddr(tx.destination)}</span>
      </div>
      <div className="rdc-tx-row">
        <span className="rdc-tx-label">Time</span>
        <span className="rdc-tx-value">{new Date(tx.timestamp).toLocaleString()}</span>
      </div>
    </div>
  )
}

// ─── Risk summary card ───────────────────────────────────────────────

function RiskSummaryCard({ decision }: { decision: RiskDecision }) {
  const s = decision.summary
  const color = verdictColor(s.verdict)
  const criticalCount = decision.signals.filter((sig) => sig.severity === "critical" && sig.status === "triggered").length

  return (
    <div className="rdc-risk-summary" style={{ borderColor: color }}>
      <div className="rdc-risk-score">
        <span className="rdc-risk-score-num" style={{ color }}>{s.score}</span>
        <span className="rdc-risk-score-max">/ 100</span>
      </div>
      <div className="rdc-risk-verdict" style={{ color }}>
        {verdictEmoji(s.verdict)} {verdictLabel(s.verdict)}
      </div>
      <div className="rdc-risk-meta">
        <span className="rdc-risk-severity" style={{ color: severityColor(s.severity) }}>
          {severityLabel(s.severity)}
        </span>
        <span className="rdc-risk-confidence">
          Confidence: {Math.round(s.confidence * 100)}%
        </span>
        {criticalCount > 0 && (
          <span className="rdc-risk-critical">{criticalCount} critical signal{criticalCount > 1 ? "s" : ""}</span>
        )}
      </div>
      <p className="rdc-risk-summary-text">{s.summary}</p>
    </div>
  )
}

// ─── Signal card ─────────────────────────────────────────────────────

function SignalCard({ signal }: { signal: RiskSignal }) {
  const [expanded, setExpanded] = useState(false)
  const sColor = sourceColor(signal.source)
  const stColor = statusColor(signal.status)

  return (
    <div className={`rdc-signal ${signal.status === "triggered" ? "rdc-signal-triggered" : ""}`}>
      <div className="rdc-signal-header" onClick={() => setExpanded(!expanded)}>
        <span className="rdc-signal-source" style={{ color: sColor }}>{sourceLabel(signal.source)}</span>
        <span className="rdc-signal-name">{signal.name}</span>
        <span className="rdc-signal-status" style={{ color: stColor }}>
          {signal.status === "triggered" ? "● TRIGGERED" : signal.status === "passed" ? "○ PASSED" : signal.status.toUpperCase()}
        </span>
        {signal.status === "triggered" && (
          <span className="rdc-signal-severity" style={{ color: severityColor(signal.severity) }}>
            {severityLabel(signal.severity)}
          </span>
        )}
        {signal.score > 0 && <span className="rdc-signal-score">+{signal.score}</span>}
        <span className="rdc-signal-toggle">{expanded ? "▾" : "▸"}</span>
      </div>
      <p className="rdc-signal-reason">{signal.reason}</p>
      {expanded && signal.evidence.length > 0 && (
        <div className="rdc-signal-evidence">
          {signal.evidence.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}
    </div>
  )
}

// ─── Intent section ──────────────────────────────────────────────────

function IntentSection({ decision }: { decision: RiskDecision }) {
  const intent = decision.intent
  return (
    <div className="rdc-intent">
      <div className="rdc-intent-summary">{intent.summary}</div>
      <div className="rdc-intent-details">
        <div className="rdc-intent-row"><span className="rdc-intent-label">Action</span><span className="rdc-intent-value">{intent.action}</span></div>
        {intent.token && <div className="rdc-intent-row"><span className="rdc-intent-label">Token</span><span className="rdc-intent-value">{intent.token}</span></div>}
        {intent.amount && <div className="rdc-intent-row"><span className="rdc-intent-label">Amount</span><span className="rdc-intent-value mono">{intent.amount}</span></div>}
        {intent.from && <div className="rdc-intent-row"><span className="rdc-intent-label">From</span><span className="rdc-intent-value mono">{shortAddr(intent.from)}</span></div>}
        {intent.to && <div className="rdc-intent-row"><span className="rdc-intent-label">To</span><span className="rdc-intent-value mono">{shortAddr(intent.to)}</span></div>}
        {intent.spender && <div className="rdc-intent-row"><span className="rdc-intent-label">Spender</span><span className="rdc-intent-value mono">{shortAddr(intent.spender)}</span></div>}
      </div>
      {intent.warnings.length > 0 && (
        <div className="rdc-intent-warnings">
          {intent.warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
        </div>
      )}
    </div>
  )
}

// ─── Simulation section ──────────────────────────────────────────────

function SimulationSection({ decision }: { decision: RiskDecision }) {
  const sim = decision.simulation
  return (
    <div className="rdc-simulation">
      <div className="rdc-sim-status">
        {sim.completed ? (
          sim.wouldSucceed ? (
            <span className="rdc-sim-would-succeed">✓ Would succeed on-chain</span>
          ) : (
            <span className="rdc-sim-would-fail">✗ Would revert on-chain</span>
          )
        ) : (
          <span className="rdc-sim-pending">◌ Simulation pending</span>
        )}
      </div>
      {sim.stateChanges.length > 0 && (
        <div className="rdc-sim-changes">
          <h4>State changes</h4>
          {sim.stateChanges.map((c, i) => <p key={i}>{c}</p>)}
        </div>
      )}
      {sim.anomalies.length > 0 && (
        <div className="rdc-sim-anomalies">
          <h4>Anomalies</h4>
          {sim.anomalies.map((a, i) => <p key={i}>⚠️ {a}</p>)}
        </div>
      )}
    </div>
  )
}

// ─── AI analysis section ─────────────────────────────────────────────

function AIAnalysisSection({ decision }: { decision: RiskDecision }) {
  const ai = decision.aiAnalysis
  return (
    <div className="rdc-ai">
      <div className="rdc-ai-confidence">
        Confidence: {Math.round(ai.confidence * 100)}%
      </div>
      <p className="rdc-ai-reasoning">{ai.reasoning}</p>
      {ai.findings.length > 0 && (
        <div className="rdc-ai-findings">
          <h4>Key findings</h4>
          {ai.findings.map((f, i) => <p key={i}>• {f}</p>)}
        </div>
      )}
      {ai.riskFactors.length > 0 && (
        <div className="rdc-ai-factors">
          <h4>Risk factors</h4>
          {ai.riskFactors.map((f, i) => <span key={i} className="rdc-ai-factor">{f}</span>)}
        </div>
      )}
    </div>
  )
}

// ─── Timeline section ────────────────────────────────────────────────

function TimelineSection({ decision }: { decision: RiskDecision }) {
  return (
    <div className="rdc-timeline">
      {decision.timeline.map((event, i) => (
        <TimelineRow key={i} event={event} isLast={i === decision.timeline.length - 1} />
      ))}
    </div>
  )
}

function TimelineRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const dotColor = event.status === "completed" ? "#16a34a" : event.status === "error" ? "#dc2626" : "#d97706"
  return (
    <div className={`rdc-timeline-row ${isLast ? "rdc-timeline-last" : ""}`}>
      <div className="rdc-timeline-line">
        <span className="rdc-timeline-dot" style={{ background: dotColor }} />
        {!isLast && <span className="rdc-timeline-connector" />}
      </div>
      <div className="rdc-timeline-content">
        <span className="rdc-timeline-label">{event.label}</span>
        <span className="rdc-timeline-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
        {event.detail && <span className="rdc-timeline-detail">{event.detail}</span>}
      </div>
    </div>
  )
}

// ─── Enforcement section ─────────────────────────────────────────────

function EnforcementSection({ decision }: { decision: RiskDecision }) {
  const enf = decision.enforcement
  const color = enforcementColor(enf.status)
  return (
    <div className="rdc-enforcement">
      <div className="rdc-enf-status" style={{ color }}>
        {enf.status === "confirmed" ? "✓" : enf.status === "submitted" ? "◌" : enf.status === "failed" ? "✗" : "—"}{" "}
        {enf.status.toUpperCase()}
      </div>
      {enf.consistent && (
        <span className="rdc-enf-consistent">Verdict and enforcement are consistent</span>
      )}
      {!enf.consistent && (
        <span className="rdc-enf-inconsistent">⚠ Verdict and enforcement disagree</span>
      )}
      {enf.guardState && (
        <div className="rdc-enf-guard">Guard state: {enf.guardState}</div>
      )}
      {enf.timestamp && (
        <div className="rdc-enf-time">Enforced: {new Date(enf.timestamp).toLocaleString()}</div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function RiskDecisionCard() {
  const [demoMode, setDemoMode] = useState(false)
  const decision = demoMode ? createDemoDecision() : null

  return (
    <section className="card rdc-card">
      <h2>Risk decision center</h2>
      <p className="rdc-description">
        Complete transaction-level risk investigation: intent → signals → analysis → verdict → enforcement.
      </p>

      <div className="rdc-controls">
        <button
          type="button"
          className={demoMode ? "rdc-btn-active" : ""}
          onClick={() => setDemoMode(!demoMode)}
        >
          {demoMode ? "Using demo data" : "Load demo decision"}
        </button>
      </div>

      {!demoMode && (
        <p className="rdc-hint">
          Decision center activates when transactions are evaluated. Click "Load demo decision" to see a sample.
        </p>
      )}

      {decision && (
        <>
          <Section title="Transaction details" defaultOpen={true}>
            <TxHeader decision={decision} />
          </Section>

          <Section title="Risk summary" defaultOpen={true}>
            <RiskSummaryCard decision={decision} />
          </Section>

          <Section title="Transaction intent" defaultOpen={true}>
            <IntentSection decision={decision} />
          </Section>

          <Section title={`Risk signals (${decision.signals.filter((s) => s.status === "triggered").length} triggered)`} defaultOpen={true}>
            <div className="rdc-signals">
              {decision.signals.map((sig) => <SignalCard key={sig.id} signal={sig} />)}
            </div>
          </Section>

          <Section title="Simulation" defaultOpen={true}>
            <SimulationSection decision={decision} />
          </Section>

          <Section title="AI analysis" defaultOpen={true}>
            <AIAnalysisSection decision={decision} />
          </Section>

          <Section title="Decision timeline" defaultOpen={true}>
            <TimelineSection decision={decision} />
          </Section>

          <Section title="Enforcement status" defaultOpen={true}>
            <EnforcementSection decision={decision} />
          </Section>
        </>
      )}

      {!demoMode && (
        <div className="rdc-empty">
          <p>No transaction selected for investigation.</p>
        </div>
      )}
    </section>
  )
}
