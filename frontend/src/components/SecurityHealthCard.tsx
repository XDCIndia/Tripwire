import { useEffect, useState } from "react"
import {
  type SecurityHealthState,
  type SecurityDependency,
  createInitialHealth,
  evaluateHealth,
  probeHealth,
} from "../securityHealth.js"

/**
 * Issue #88: Security Degraded-Mode & Recovery UX
 *
 * Shows the security health state, affected actions, dependency status,
 * and recovery transitions. Makes degraded security impossible to miss.
 */

function modeColor(mode: string): string {
  switch (mode) {
    case "normal":
      return "#16a34a"
    case "degraded":
      return "#d97706"
    case "unverified":
      return "#6b7280"
    case "recovering":
      return "#2563eb"
    default:
      return "#6b7280"
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "normal":
      return "SECURE & VERIFIED"
    case "degraded":
      return "SECURITY DEGRADED"
    case "unverified":
      return "UNVERIFIED"
    case "recovering":
      return "RECOVERING"
    default:
      return "UNKNOWN"
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "healthy":
      return "✓"
    case "failed":
      return "✕"
    case "stale":
      return "⏱"
    default:
      return "?"
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "healthy":
      return "#16a34a"
    case "failed":
      return "#dc2626"
    case "stale":
      return "#d97706"
    default:
      return "#6b7280"
  }
}

// ─── Dependency row ──────────────────────────────────────────────────

function DependencyRow({ dep }: { dep: SecurityDependency }) {
  const color = statusColor(dep.status)
  return (
    <div className={`health-dep-row ${dep.status === "failed" ? "health-dep-failed" : ""}`}>
      <div className="health-dep-header">
        <span className="health-dep-icon" style={{ color }}>{statusIcon(dep.status)}</span>
        <span className="health-dep-name">{dep.name}</span>
        <span className="health-dep-status" style={{ color }}>{dep.status.toUpperCase()}</span>
      </div>
      <p className="health-dep-detail">{dep.detail}</p>
      {dep.requiredFor.length > 0 && (
        <p className="health-dep-actions">Required for: {dep.requiredFor.join(", ")}</p>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function SecurityHealthCard() {
  const [health, setHealth] = useState<SecurityHealthState>(createInitialHealth())
  const [isProbing, setIsProbing] = useState(false)
  const [previousMode, setPreviousMode] = useState<SecurityHealthState["mode"] | undefined>()

  async function runProbe() {
    setIsProbing(true)
    const checks = await probeHealth()
    const details = new Map<string, string>()
    for (const [id, status] of checks) {
      if (status === "healthy") details.set(id, "Operational")
      else if (status === "failed") details.set(id, "Connection failed")
      else if (status === "stale") details.set(id, "Data may be stale")
      else details.set(id, "Status unknown")
    }
    const newHealth = evaluateHealth(checks, details, previousMode)
    setPreviousMode(health.mode)
    setHealth(newHealth)
    setIsProbing(false)
  }

  // Auto-probe on mount
  useEffect(() => {
    let cancelled = false
    async function probe() {
      setIsProbing(true)
      const checks = await probeHealth()
      const details = new Map<string, string>()
      for (const [id, status] of checks) {
        if (status === "healthy") details.set(id, "Operational")
        else if (status === "failed") details.set(id, "Connection failed")
        else if (status === "stale") details.set(id, "Data may be stale")
        else details.set(id, "Status unknown")
      }
      if (!cancelled) {
        const newHealth = evaluateHealth(checks, details)
        setHealth(newHealth)
        setIsProbing(false)
      }
    }
    void probe()
    return () => { cancelled = true }
  }, [])

  const mode = health.mode
  const color = modeColor(mode)

  return (
    <section className="card health-card" style={{ borderColor: `${color}40` }}>
      <div className="health-header">
        <h2>Security health</h2>
        <button type="button" className="health-retry-btn" onClick={() => void runProbe()} disabled={isProbing}>
          {isProbing ? "Checking…" : "Retry verification"}
        </button>
      </div>

      {/* Mode banner */}
      <div className="health-mode-banner" style={{ background: `${color}15`, borderColor: `${color}40` }}>
        <span className="health-mode-badge" style={{ background: color }}>
          {mode === "normal" ? "✓" : mode === "degraded" ? "⚠" : mode === "recovering" ? "↻" : "?"} {modeLabel(mode)}
        </span>
        <p className="health-summary">{health.summary}</p>
      </div>

      {/* Restricted actions */}
      {health.restrictedActions.length > 0 && (
        <div className="health-restricted">
          <h3>Affected actions</h3>
          <p className="health-restricted-desc">The following actions are restricted or unreliable in degraded mode:</p>
          <ul className="health-restricted-list">
            {health.restrictedActions.map((action) => (
              <li key={action} className="health-restricted-item">{action}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Normal mode message */}
      {mode === "normal" && !health.recovering && (
        <div className="health-normal-msg">
          <p>All security systems are operational. No actions are restricted.</p>
        </div>
      )}

      {/* Recovery message */}
      {health.recovering && (
        <div className="health-recovering-msg">
          <p>✓ Recovery detected. All systems restored. Restricted actions are now available.</p>
        </div>
      )}

      {/* Dependencies */}
      <div className="health-deps">
        <h3>Dependency status</h3>
        {health.dependencies.map((dep) => (
          <DependencyRow key={dep.id} dep={dep} />
        ))}
      </div>
    </section>
  )
}
