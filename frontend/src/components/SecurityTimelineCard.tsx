import { useState } from "react"
import {
  type SecurityEvent,
  type TimelineEntry,
  buildCorrelatedTimeline,
  countTransitions,
} from "../securityTimeline.js"

/**
 * Issue #87: Security Event Timeline with Causal Correlation UI
 *
 * Displays a chronological chain of security events with causal links,
 * state transitions, and expandable details.
 */

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

function eventTypeIcon(type: string): string {
  switch (type) {
    case "transaction_detected":
      return "🔍"
    case "risk_signal":
      return "⚡"
    case "simulation_result":
      return "🔬"
    case "verdict":
      return "⚖️"
    case "relayer_action":
      return "🚀"
    case "onchain_confirmation":
      return "✓"
    case "guard_check":
      return "🛡️"
    case "freeze_event":
      return "❄️"
    case "error":
      return "✕"
    default:
      return "○"
  }
}

function eventTypeLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function sourceLabel(source: string): string {
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function severityColor(severity?: string): string {
  switch (severity) {
    case "critical":
      return "#dc2626"
    case "warning":
      return "#d97706"
    case "info":
      return "#2563eb"
    default:
      return "#6b7280"
  }
}

function stateColor(state: string): string {
  switch (state) {
    case "pending":
      return "#d97706"
    case "low_risk":
    case "allowed":
    case "confirmed":
      return "#16a34a"
    case "medium_risk":
    case "delayed":
      return "#d97706"
    case "high_risk":
    case "blocked":
    case "frozen":
    case "reverted":
      return "#dc2626"
    default:
      return "#6b7280"
  }
}

// ─── Event entry component ───────────────────────────────────────────

function EventEntry({ entry, depth }: { entry: TimelineEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const { event, stateTransition } = entry
  const hasDetails = event.cause || event.evidence || event.blockNumber

  return (
    <div className={`tl-entry ${stateTransition ? "tl-entry-transition" : ""}`} style={{ marginLeft: depth * 20 }}>
      {/* Connector line */}
      <div className="tl-connector">
        <div className="tl-dot" style={{ background: severityColor(event.severity) }} />
        <div className="tl-line" />
      </div>

      {/* Event content */}
      <div className="tl-content" onClick={() => hasDetails && setExpanded(!expanded)}>
        <div className="tl-header">
          <span className="tl-icon">{eventTypeIcon(event.type)}</span>
          <span className="tl-type">{eventTypeLabel(event.type)}</span>
          <span className="tl-source">{sourceLabel(event.source)}</span>
          {stateTransition && (
            <span className="tl-transition-badge">State change</span>
          )}
          <span className="tl-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>

        <div className="tl-states">
          {event.previousState && (
            <span className="tl-state" style={{ color: stateColor(event.previousState) }}>
              {event.previousState}
            </span>
          )}
          {event.previousState && <span className="tl-arrow">→</span>}
          <span className="tl-state" style={{ color: stateColor(event.newState) }}>
            {event.newState}
          </span>
        </div>

        {event.txHash && (
          <div className="tl-hash">Tx: <span className="mono">{shortHash(event.txHash)}</span></div>
        )}

        {/* Expandable details */}
        {expanded && hasDetails && (
          <div className="tl-details">
            {event.blockNumber && (
              <div className="tl-detail-row">
                <span className="tl-detail-label">Block</span>
                <span className="mono">{event.blockNumber}</span>
              </div>
            )}
            {event.cause && (
              <div className="tl-detail-row">
                <span className="tl-detail-label">Cause</span>
                <span>{event.cause}</span>
              </div>
            )}
            {event.evidence && (
              <div className="tl-detail-row">
                <span className="tl-detail-label">Evidence</span>
                <span>{event.evidence}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Children (causal chain) */}
      {entry.children.length > 0 && (
        <div className="tl-children">
          {entry.children.map((child) => (
            <EventEntry key={child.event.id} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_EVENTS: SecurityEvent[] = [
  {
    id: "evt-1",
    type: "transaction_detected",
    source: "watcher",
    timestamp: new Date(Date.now() - 300000).toISOString(),
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "idle",
    newState: "pending",
    cause: "New pending transaction detected in Safe queue",
    severity: "info",
  },
  {
    id: "evt-2",
    type: "risk_signal",
    source: "rule_engine",
    timestamp: new Date(Date.now() - 240000).toISOString(),
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "pending",
    newState: "scored",
    cause: "Rule engine evaluated calldata and context",
    evidence: "Matched signals: setApprovalForAll, first-seen counterparty. Score: 75/100",
    severity: "warning",
  },
  {
    id: "evt-3",
    type: "simulation_result",
    source: "simulator",
    timestamp: new Date(Date.now() - 180000).toISOString(),
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "scored",
    newState: "simulated",
    cause: "Fork simulation executed against current chain state",
    evidence: "Allowance changed: 0 → unlimited for NFT collection. Balance unchanged.",
    severity: "warning",
  },
  {
    id: "evt-4",
    type: "verdict",
    source: "rule_engine",
    timestamp: new Date(Date.now() - 120000).toISOString(),
    blockNumber: 18000001,
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "simulated",
    newState: "high_risk",
    cause: "Score 75 exceeds high_risk threshold (70)",
    evidence: "Action: BLOCK. Release: N/A (blocking).",
    severity: "critical",
  },
  {
    id: "evt-5",
    type: "relayer_action",
    source: "relayer",
    timestamp: new Date(Date.now() - 60000).toISOString(),
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "high_risk",
    newState: "submitted",
    cause: "Verdict submitted to RiskRegistry on-chain",
    evidence: "submitVerdict(txHash, HIGH_RISK, score=75)",
    severity: "info",
  },
  {
    id: "evt-6",
    type: "guard_check",
    source: "guard",
    timestamp: new Date(Date.now() - 30000).toISOString(),
    blockNumber: 18000002,
    txHash: "0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888",
    previousState: "submitted",
    newState: "blocked",
    cause: "TripwireGuard.checkTransaction() read HIGH_RISK verdict",
    evidence: "Transaction reverted by guard. Execution denied.",
    severity: "critical",
  },
]

// ─── Main component ──────────────────────────────────────────────────

export function SecurityTimelineCard() {
  const [demoMode, setDemoMode] = useState(false)

  const events: SecurityEvent[] = demoMode ? DEMO_EVENTS : []
  const timeline = buildCorrelatedTimeline(events)
  const transitions = countTransitions(timeline)

  return (
    <section className="card tl-card">
      <h2>Security event timeline</h2>
      <p className="tl-description">
        Chronological chain of security events with causal correlation.
        Shows what happened, when, and why the security state changed.
      </p>

      <div className="tl-controls">
        <button type="button" className={demoMode ? "tl-demo-active" : ""} onClick={() => setDemoMode(!demoMode)}>
          {demoMode ? "Using demo data" : "Load demo timeline"}
        </button>
      </div>

      {!demoMode && (
        <p className="tl-hint">
          Timeline activates when transaction events are detected. Click "Load demo timeline" to see a sample flow.
        </p>
      )}

      {timeline.length > 0 ? (
        <>
          <div className="tl-summary">
            <span>{timeline.length} events</span>
            <span>{transitions} state transition{transitions !== 1 ? "s" : ""}</span>
            <span>{events[events.length - 1]?.txHash ? shortHash(events[events.length - 1].txHash) : ""}</span>
          </div>

          <div className="tl-list">
            {timeline.map((entry) => (
              <EventEntry key={entry.event.id} entry={entry} depth={0} />
            ))}
          </div>
        </>
      ) : events.length > 0 ? (
        <div className="tl-empty">
          <p>No events to display.</p>
        </div>
      ) : (
        <div className="tl-empty">
          <p>No timeline data.</p>
        </div>
      )}
    </section>
  )
}
