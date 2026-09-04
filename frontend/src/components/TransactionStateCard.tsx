import { useState } from "react"
import {
  type SecurityState,
  type StateUpdate,
  type TransactionState,
  TransactionStateMachine,
  createDemoTransitions,
  stateColor,
  stateLabel,
  syncColor,
  syncLabel,
  TERMINAL_STATES,
} from "../transactionStateMachine.js"

/**
 * Issue #82: Transaction State Machine & Stale State Protection UI
 *
 * Displays transaction security state, valid transitions, rejection
 * history, and sync status. Shows the state machine in action with
 * demo data.
 */

// ─── State flow diagram ──────────────────────────────────────────────

const STATE_FLOW: SecurityState[] = [
  "DETECTED",
  "ANALYZING",
  "VERDICT_READY",
  "ENFORCEMENT_PENDING",
  "ENFORCED",
]

const FAILURE_BRANCHES: { from: SecurityState; to: SecurityState }[] = [
  { from: "ANALYZING", to: "ANALYSIS_FAILED" },
  { from: "VERDICT_READY", to: "BLOCKED" },
  { from: "ENFORCEMENT_PENDING", to: "ENFORCEMENT_FAILED" },
]

// ─── State badge ─────────────────────────────────────────────────────

function StateBadge({ state, size }: { state: SecurityState; size?: "small" | "normal" }) {
  const color = stateColor(state)
  const isTerminal = TERMINAL_STATES.includes(state)
  return (
    <span
      className={`state-badge ${size === "small" ? "state-badge-small" : ""} ${isTerminal ? "state-badge-terminal" : ""}`}
      style={{ borderColor: color, color }}
    >
      {stateLabel(state)}
    </span>
  )
}

// ─── Transition row ──────────────────────────────────────────────────

function TransitionRow({ transition, index }: { transition: { from: SecurityState; to: SecurityState; version: number; timestamp: string; reason?: string }; index: number }) {
  return (
    <div className="state-transition">
      <span className="state-transition-index">#{index + 1}</span>
      <span className="state-transition-from" style={{ color: stateColor(transition.from) }}>
        {stateLabel(transition.from)}
      </span>
      <span className="state-transition-arrow">→</span>
      <span className="state-transition-to" style={{ color: stateColor(transition.to) }}>
        {stateLabel(transition.to)}
      </span>
      <span className="state-transition-version">v{transition.version}</span>
      <span className="state-transition-time">
        {new Date(transition.timestamp).toLocaleTimeString()}
      </span>
      {transition.reason && (
        <span className="state-transition-reason">{transition.reason}</span>
      )}
    </div>
  )
}

// ─── State flow diagram ──────────────────────────────────────────────

function StateFlowDiagram({ current }: { current: SecurityState }) {
  return (
    <div className="state-flow">
      <h3>State machine</h3>
      <div className="state-flow-main">
        {STATE_FLOW.map((state, i) => (
          <div key={state} className="state-flow-step">
            <div
              className={`state-flow-node ${current === state ? "state-flow-active" : ""} ${
                TERMINAL_STATES.includes(state) && current === state ? "state-flow-terminal" : ""
              }`}
              style={{
                borderColor: stateColor(state),
                ...(current === state ? { background: stateColor(state), color: "#fff" } : {}),
              }}
            >
              {stateLabel(state)}
            </div>
            {i < STATE_FLOW.length - 1 && <span className="state-flow-connector">→</span>}
          </div>
        ))}
      </div>
      <div className="state-flow-failures">
        {FAILURE_BRANCHES.map(({ from, to }) => (
          <div key={to} className="state-flow-failure">
            <span className="state-flow-failure-from" style={{ color: stateColor(from) }}>
              {stateLabel(from)}
            </span>
            <span className="state-flow-failure-arrow">↗</span>
            <span className="state-flow-failure-to" style={{ color: stateColor(to) }}>
              {stateLabel(to)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Rejection simulator ─────────────────────────────────────────────

function RejectionDemo({ machine, txHash }: { machine: TransactionStateMachine; txHash: string }) {
  const [result, setResult] = useState<{ accepted: boolean; reason?: string } | null>(null)

  function tryStaleUpdate() {
    const cur = machine.getState(txHash)
    const stale: StateUpdate = {
      txHash,
      state: "ANALYZING",
      version: cur.version, // Same version = stale
      timestamp: new Date().toISOString(),
    }
    const res = machine.applyUpdate(stale)
    setResult({ accepted: res.accepted, reason: res.rejectionReason })
  }

  function tryInvalidTransition() {
    const cur = machine.getState(txHash)
    // Try to go backward from ENFORCED to DETECTED
    const invalid: StateUpdate = {
      txHash,
      state: "DETECTED",
      version: cur.version + 1,
      timestamp: new Date().toISOString(),
    }
    const res = machine.applyUpdate(invalid)
    setResult({ accepted: res.accepted, reason: res.rejectionReason })
  }

  function tryInvalidVersion() {
    const old: StateUpdate = {
      txHash,
      state: "ANALYZING",
      version: 1, // Way behind current version
      timestamp: new Date().toISOString(),
    }
    const res = machine.applyUpdate(old)
    setResult({ accepted: res.accepted, reason: res.rejectionReason })
  }

  return (
    <div className="state-rejection">
      <h3>Rejection demo</h3>
      <p className="state-rejection-desc">
        Try invalid updates to see the state machine reject them.
      </p>
      <div className="state-rejection-buttons">
        <button type="button" onClick={tryStaleUpdate}>Stale update</button>
        <button type="button" onClick={tryInvalidTransition}>Invalid transition</button>
        <button type="button" onClick={tryInvalidVersion}>Old version</button>
      </div>
      {result && (
        <div className={`state-rejection-result ${result.accepted ? "state-rejection-accepted" : "state-rejection-rejected"}`}>
          <span className="state-rejection-status">
            {result.accepted ? "✓ ACCEPTED" : "✗ REJECTED"}
          </span>
          {result.reason && <span className="state-rejection-reason">{result.reason}</span>}
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function TransactionStateCard() {
  const [machine] = useState(() => new TransactionStateMachine())
  const [txState, setTxState] = useState<TransactionState | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)

  function loadDemo() {
    machine.clear()
    const { txHash, updates } = createDemoTransitions()
    // Apply all transitions up to stepIndex
    for (let i = 0; i <= stepIndex && i < updates.length; i++) {
      machine.applyUpdate(updates[i])
    }
    setTxState(machine.getState(txHash))
    setDemoMode(true)
  }

  function stepForward() {
    if (!demoMode) return
    const { txHash, updates } = createDemoTransitions()
    if (stepIndex < updates.length - 1) {
      const next = stepIndex + 1
      setStepIndex(next)
      machine.applyUpdate(updates[next])
      setTxState(machine.getState(txHash))
    }
  }

  function resetDemo() {
    machine.clear()
    setStepIndex(0)
    setDemoMode(false)
    setTxState(null)
  }

  return (
    <section className="card state-card">
      <h2>Transaction state</h2>
      <p className="state-description">
        Deterministic state machine ensures transaction security status only moves
        through valid lifecycle transitions. Stale and invalid updates are rejected.
      </p>

      <div className="state-controls">
        <button
          type="button"
          className={demoMode ? "state-btn-active" : ""}
          onClick={() => { resetDemo(); setTimeout(loadDemo, 0) }}
        >
          {demoMode ? "Reset demo" : "Load demo"}
        </button>
        {demoMode && txState && !TERMINAL_STATES.includes(txState.current) && (
          <button type="button" onClick={stepForward}>
            Step forward
          </button>
        )}
      </div>

      {!demoMode && (
        <p className="state-hint">
          State machine activates when transactions are tracked. Click "Load demo" to see it in action.
        </p>
      )}

      {txState && (
        <>
          {/* Current state header */}
          <div className="state-status" style={{ borderColor: stateColor(txState.current) }}>
            <div className="state-status-main">
              <span className="state-dot" style={{ background: stateColor(txState.current) }} />
              <span className="state-current" style={{ color: stateColor(txState.current) }}>
                {stateLabel(txState.current)}
              </span>
              {TERMINAL_STATES.includes(txState.current) && (
                <span className="state-terminal-badge">TERMINAL</span>
              )}
            </div>
            <div className="state-meta">
              {txState.previous && (
                <div className="state-meta-row">
                  <span className="state-meta-label">Previous</span>
                  <StateBadge state={txState.previous} size="small" />
                </div>
              )}
              <div className="state-meta-row">
                <span className="state-meta-label">Version</span>
                <span className="state-meta-value mono">#{txState.version}</span>
              </div>
              <div className="state-meta-row">
                <span className="state-meta-label">Updated</span>
                <span className="state-meta-value">{new Date(txState.lastUpdated).toLocaleTimeString()}</span>
              </div>
              <div className="state-meta-row">
                <span className="state-meta-label">Sync</span>
                <span className="state-sync" style={{ color: syncColor(txState.syncStatus) }}>
                  ● {syncLabel(txState.syncStatus)}
                </span>
              </div>
            </div>
          </div>

          {/* State flow diagram */}
          <StateFlowDiagram current={txState.current} />

          {/* Transition history */}
          {txState.history.length > 0 && (
            <div className="state-history">
              <h3>Transition history</h3>
              {txState.history.map((t, i) => (
                <TransitionRow key={i} transition={t} index={i} />
              ))}
            </div>
          )}

          {/* Rejection demo */}
          <RejectionDemo machine={machine} txHash={txState.txHash} />
        </>
      )}

      {!txState && !demoMode && (
        <div className="state-empty">
          <p>No transaction state to display.</p>
        </div>
      )}
    </section>
  )
}
