import { useState } from "react"
import {
  type SimulationResult,
  type TransactionFingerprint,
  type IntegrityCheck,
  createFingerprint,
  checkIntegrity,
} from "../simulationIntegrity.js"

/**
 * Issue #92: Transaction Simulation Result Integrity & Mismatch Detection UI
 *
 * Shows whether the simulation result is still valid for the current
 * transaction. Invalidates when any security-critical field changes.
 */

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function statusColor(status: string): string {
  switch (status) {
    case "verified":
      return "#16a34a"
    case "invalid":
      return "#dc2626"
    case "expired":
      return "#d97706"
    default:
      return "#6b7280"
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "verified":
      return "✓"
    case "invalid":
      return "⚠"
    case "expired":
      return "⏱"
    default:
      return "?"
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "safe":
      return "#16a34a"
    case "warning":
      return "#d97706"
    case "danger":
      return "#dc2626"
    default:
      return "#6b7280"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_SIMULATED: TransactionFingerprint = createFingerprint({
  chainId: 11155111,
  safeAddress: "0xaaaa000000000000000000000000000000000001",
  target: "0xtoken00000000000000000000000000000000000001",
  value: "0",
  calldata: "0x095ea7b3000000000000000000000000bbbb0000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064",
  operation: "call",
  nonce: 42,
})

const DEMO_SIMULATION: SimulationResult = {
  fingerprint: DEMO_SIMULATED,
  outcome: "safe",
  summary: "ERC-20 approve for 100 USDC to known spender. No state changes beyond allowance.",
  stateChanges: ["Allowance: 0 → 100 USDC for 0xbbbb…"],
  simulatedAt: new Date().toISOString(),
}

const DEMO_CHANGED: TransactionFingerprint = createFingerprint({
  chainId: 11155111,
  safeAddress: "0xaaaa000000000000000000000000000000000001",
  target: "0xtoken00000000000000000000000000000000000001",
  value: "0",
  calldata: "0x095ea7b3000000000000000000000000cccc0000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // changed spender + unlimited
  operation: "call",
  nonce: 42,
})

// ─── Main component ──────────────────────────────────────────────────

export function SimulationIntegrityCard() {
  const [demoMode, setDemoMode] = useState<"none" | "valid" | "mismatch">("none")
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [current, setCurrent] = useState<TransactionFingerprint>(DEMO_SIMULATED)

  const integrity: IntegrityCheck = checkIntegrity(simulation, current)

  function handleSimulate() {
    const fp = createFingerprint(current)
    setSimulation({
      fingerprint: fp,
      outcome: "safe",
      summary: "Simulation completed. No dangerous state changes detected.",
      stateChanges: [],
      simulatedAt: new Date().toISOString(),
    })
  }

  function handleDemoValid() {
    setDemoMode("valid")
    setCurrent(DEMO_SIMULATED)
    setSimulation(DEMO_SIMULATION)
  }

  function handleDemoMismatch() {
    setDemoMode("mismatch")
    setCurrent(DEMO_CHANGED)
    setSimulation(DEMO_SIMULATION)
  }

  function handleReset() {
    setDemoMode("none")
    setSimulation(null)
    setCurrent(DEMO_SIMULATED)
  }

  return (
    <section className="card sim-integrity-card">
      <h2>Simulation integrity</h2>
      <p className="sim-integrity-description">
        Verifies that the current transaction matches the one that was simulated.
        If the transaction changes after simulation, the result is invalidated.
      </p>

      <div className="sim-integrity-controls">
        <button type="button" className={demoMode === "valid" ? "sim-integrity-demo-active" : ""} onClick={handleDemoValid}>
          Demo: verified
        </button>
        <button type="button" className={demoMode === "mismatch" ? "sim-integrity-demo-drifted" : ""} onClick={handleDemoMismatch}>
          Demo: mismatch
        </button>
        <button type="button" onClick={handleReset}>Reset</button>
      </div>

      {/* Simulation status */}
      <div className="sim-integrity-status" style={{ borderColor: statusColor(integrity.status) }}>
        <div className="sim-integrity-status-header">
          <span className="sim-integrity-status-badge" style={{ background: statusColor(integrity.status) }}>
            {statusIcon(integrity.status)} {integrity.status === "verified" ? "SIMULATION VERIFIED" : integrity.status === "invalid" ? "SIMULATION INVALID" : "NO SIMULATION"}
          </span>
        </div>
        <p className="sim-integrity-explanation">{integrity.explanation}</p>
      </div>

      {/* Field comparison table */}
      {simulation && (
        <div className="sim-integrity-fields">
          <h3>Transaction match</h3>
          <table className="sim-integrity-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Simulated</th>
                <th>Current</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {integrity.fieldDetails.map((fd) => (
                <tr key={fd.field} className={fd.matches ? "" : "sim-integrity-row-changed"}>
                  <td className="sim-integrity-field-name">{fd.field}</td>
                  <td className="mono sim-integrity-field-val">
                    {fd.field === "calldata" ? `${fd.simulated.slice(0, 18)}…` : fd.field === "target" || fd.field === "safe" ? shortAddr(fd.simulated) : fd.simulated}
                  </td>
                  <td className="mono sim-integrity-field-val">
                    {fd.field === "calldata" ? `${fd.current.slice(0, 18)}…` : fd.field === "target" || fd.field === "safe" ? shortAddr(fd.current) : fd.current}
                  </td>
                  <td>
                    <span className={fd.matches ? "sim-integrity-match" : "sim-integrity-mismatch"}>
                      {fd.matches ? "✓ Match" : "✕ Changed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Simulation result */}
      {simulation && integrity.status === "verified" && (
        <div className="sim-integrity-result">
          <h3>Simulation result</h3>
          <div className="sim-integrity-outcome" style={{ borderColor: outcomeColor(simulation.outcome) }}>
            <span className="sim-integrity-outcome-badge" style={{ background: outcomeColor(simulation.outcome) }}>
              {simulation.outcome.toUpperCase()}
            </span>
            <p className="sim-integrity-summary">{simulation.summary}</p>
            {simulation.stateChanges.length > 0 && (
              <ul className="sim-integrity-changes">
                {simulation.stateChanges.map((change, i) => (
                  <li key={i}>{change}</li>
                ))}
              </ul>
            )}
          </div>
          <p className="sim-integrity-time">
            Simulated at {new Date(simulation.simulatedAt).toLocaleString()}
          </p>
        </div>
      )}

      {/* Mismatch detail */}
      {integrity.status === "invalid" && integrity.changedFields.length > 0 && (
        <div className="sim-integrity-drift-detail">
          <h3>Changed fields</h3>
          {integrity.fieldDetails
            .filter((fd) => !fd.matches)
            .map((fd) => (
              <div key={fd.field} className="sim-integrity-drift-field">
                <span className="sim-integrity-drift-label">{fd.field}</span>
                <div className="sim-integrity-drift-values">
                  <div>
                    <span className="sim-integrity-drift-sublabel">Simulated:</span>
                    <span className="mono">{fd.field === "calldata" ? `${fd.simulated.slice(0, 24)}…` : fd.simulated}</span>
                  </div>
                  <div>
                    <span className="sim-integrity-drift-sublabel">Current:</span>
                    <span className="mono">{fd.field === "calldata" ? `${fd.current.slice(0, 24)}…` : fd.current}</span>
                  </div>
                </div>
              </div>
            ))}
          <p className="sim-integrity-drift-warning">
            Previous simulation cannot be trusted. Re-simulate the updated transaction.
          </p>
        </div>
      )}

      {/* Manual simulate button */}
      {demoMode === "none" && !simulation && (
        <button type="button" className="sim-integrity-simulate-btn" onClick={handleSimulate}>
          Run simulation
        </button>
      )}
    </section>
  )
}
