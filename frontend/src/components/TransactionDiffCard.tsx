import { useState } from "react"
import {
  type TransactionDiff,
  type BalanceDiff,
  type AllowanceDiff,
  type OperatorDiff,
  type PermissionDiff,
  type RecipientExposure,
  type RiskSignal,
  createDemoDiff,
  hasMaterialChanges,
  getTotalRiskScore,
} from "../transactionDiff.js"

/**
 * Issue #84: Pre-Execution Transaction Diff & Risk Impact Viewer
 *
 * Shows exactly how a proposed transaction changes the wallet's
 * security-sensitive state before execution. Before/after comparison
 * with material change highlighting.
 */

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function formatAmount(wei: string, decimals = 18): string {
  try {
    const big = BigInt(wei)
    if (big === 0n) return "0"
    const whole = big / (10n ** BigInt(decimals))
    const frac = big % (10n ** BigInt(decimals))
    if (frac === 0n) return whole.toString()
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "")
    return `${whole}.${fracStr}`
  } catch {
    return wei
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "increased": return "↑"
    case "decreased": return "↓"
    case "new": return "+"
    case "removed": return "−"
    case "unknown": return "?"
    default: return "─"
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "increased": return "diff-increased"
    case "decreased": return "diff-decreased"
    case "new": return "diff-new"
    case "removed": return "diff-removed"
    case "unknown": return "diff-unknown"
    default: return "diff-unchanged"
  }
}

function severityClass(severity: string): string {
  switch (severity) {
    case "critical": return "risk-critical"
    case "high": return "risk-high"
    case "medium": return "risk-medium"
    default: return "risk-low"
  }
}

// ─── Sub-components ──────────────────────────────────────────────────

function BalanceRow({ diff }: { diff: BalanceDiff }) {
  const label = diff.isNative ? (diff.tokenSymbol ?? "Native") : (diff.tokenSymbol ?? shortAddr(diff.token))
  return (
    <tr className={statusClass(diff.status)}>
      <td className="diff-label">{label}</td>
      <td className="diff-before mono">{diff.status === "unknown" ? "?" : formatAmount(diff.before)}</td>
      <td className="diff-arrow">{statusIcon(diff.status)}</td>
      <td className="diff-after mono">{diff.status === "unknown" ? "?" : formatAmount(diff.after)}</td>
      <td className="diff-status">{diff.status.toUpperCase()}</td>
    </tr>
  )
}

function AllowanceRow({ diff }: { diff: AllowanceDiff }) {
  const tokenLabel = diff.tokenSymbol ?? shortAddr(diff.token)
  return (
    <tr className={`${statusClass(diff.status)} ${diff.isUnlimited ? "diff-critical" : ""}`}>
      <td className="diff-label">
        {tokenLabel} → {shortAddr(diff.spender)}
        {diff.isUnlimited && <span className="diff-badge diff-badge-unlimited">UNLIMITED</span>}
        {diff.isNew && <span className="diff-badge diff-badge-new">NEW</span>}
      </td>
      <td className="diff-before mono">{diff.status === "unknown" ? "?" : formatAmount(diff.before)}</td>
      <td className="diff-arrow">{statusIcon(diff.status)}</td>
      <td className="diff-after mono">{diff.status === "unknown" ? "?" : formatAmount(diff.after)}</td>
      <td className="diff-status">{diff.status.toUpperCase()}</td>
    </tr>
  )
}

function OperatorRow({ diff }: { diff: OperatorDiff }) {
  const label = diff.tokenSymbol ?? shortAddr(diff.token)
  return (
    <tr className={statusClass(diff.status)}>
      <td className="diff-label">
        {shortAddr(diff.operator)} for {label}
        {diff.isNew && <span className="diff-badge diff-badge-new">NEW</span>}
      </td>
      <td className="diff-before">{diff.before ? "✓" : "✗"}</td>
      <td className="diff-arrow">{statusIcon(diff.status)}</td>
      <td className="diff-after">{diff.approved ? "✓" : "✗"}</td>
      <td className="diff-status">{diff.status.toUpperCase()}</td>
    </tr>
  )
}

function PermissionRow({ diff }: { diff: PermissionDiff }) {
  const label = diff.contractName ?? shortAddr(diff.contract)
  return (
    <tr className={statusClass(diff.status)}>
      <td className="diff-label">
        {label}: {diff.permission}
        {diff.isNew && <span className="diff-badge diff-badge-new">NEW</span>}
      </td>
      <td className="diff-before">{diff.before ? "✓" : "✗"}</td>
      <td className="diff-arrow">{statusIcon(diff.status)}</td>
      <td className="diff-after">{diff.after ? "✓" : "✗"}</td>
      <td className="diff-status">{diff.status.toUpperCase()}</td>
    </tr>
  )
}

function RecipientRow({ exposure }: { exposure: RecipientExposure }) {
  return (
    <tr className={exposure.isFirstSeen ? "diff-new" : ""}>
      <td className="diff-label">
        {shortAddr(exposure.address)}
        {exposure.isFirstSeen && <span className="diff-badge diff-badge-firstseen">FIRST SEEN</span>}
      </td>
      <td className="diff-before">—</td>
      <td className="diff-arrow">→</td>
      <td className="diff-after mono">{formatAmount(exposure.valueSent)} {exposure.assetType}</td>
      <td className="diff-status">{exposure.isFirstSeen ? "NEW RECIPIENT" : "KNOWN"}</td>
    </tr>
  )
}

function RiskSignalRow({ signal }: { signal: RiskSignal }) {
  return (
    <div className={`diff-signal ${severityClass(signal.severity)}`}>
      <span className="diff-signal-severity">{signal.severity.toUpperCase()}</span>
      <span className="diff-signal-text">{signal.description}</span>
    </div>
  )
}

// ─── Section wrapper ─────────────────────────────────────────────────

function DiffSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="diff-section">
      <div className="diff-section-header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-section-title">{title}</span>
        <span className="diff-section-count">{count}</span>
        <span className="diff-section-toggle">{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && <div className="diff-section-body">{children}</div>}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash
}

export function TransactionDiffCard() {
  const [demoMode, setDemoMode] = useState(false)
  const diff: TransactionDiff | null = demoMode ? createDemoDiff() : null

  const riskScore = diff ? getTotalRiskScore(diff) : 0
  const materialChanges = diff ? hasMaterialChanges(diff) : false
  const criticalCount = diff?.riskSignals.filter((s) => s.severity === "critical").length ?? 0

  return (
    <section className="card txdiff-card">
      <h2>Pre-execution diff</h2>
      <p className="txdiff-description">
        See exactly how a proposed transaction changes your wallet's security-sensitive state
        before you execute it.
      </p>

      <div className="txdiff-controls">
        <button
          type="button"
          className={demoMode ? "txdiff-demo-active" : ""}
          onClick={() => setDemoMode(!demoMode)}
        >
          {demoMode ? "Using demo data" : "Load demo diff"}
        </button>
      </div>

      {!demoMode && (
        <p className="txdiff-hint">
          Diff viewer activates when a transaction is proposed. Click "Load demo diff" to see a sample.
        </p>
      )}

      {diff && (
        <>
          {/* Transaction header */}
          <div className="txdiff-header">
            <div className="txdiff-header-row">
              <span className="txdiff-hash mono">{shortHash(diff.txHash)}</span>
              <span className={`txdiff-score ${criticalCount > 0 ? "txdiff-score-critical" : riskScore > 30 ? "txdiff-score-warn" : ""}`}>
                Risk: {riskScore}/100
              </span>
            </div>
            <div className="txdiff-header-meta">
              <span>To: <span className="mono">{shortAddr(diff.to)}</span></span>
              <span>Value: <span className="mono">{formatAmount(diff.value)} XDC</span></span>
            </div>
            {materialChanges && (
              <div className="txdiff-material-notice">
                ⚠️ This transaction makes material changes to your wallet state
              </div>
            )}
          </div>

          {/* Risk signals */}
          {diff.riskSignals.length > 0 && (
            <DiffSection title="Risk signals" count={diff.riskSignals.length}>
              <div className="diff-signals">
                {diff.riskSignals
                  .sort((a, b) => {
                    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
                    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4)
                  })
                  .map((signal, i) => (
                    <RiskSignalRow key={i} signal={signal} />
                  ))}
              </div>
            </DiffSection>
          )}

          {/* Balance changes */}
          {diff.balanceChanges.length > 0 && (
            <DiffSection title="Asset balances" count={diff.balanceChanges.length}>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Before</th>
                    <th></th>
                    <th>After</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.balanceChanges.map((d, i) => <BalanceRow key={i} diff={d} />)}
                </tbody>
              </table>
            </DiffSection>
          )}

          {/* Allowance changes */}
          {diff.allowanceChanges.length > 0 && (
            <DiffSection title="Token allowances" count={diff.allowanceChanges.length}>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Allowance</th>
                    <th>Before</th>
                    <th></th>
                    <th>After</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.allowanceChanges.map((d, i) => <AllowanceRow key={i} diff={d} />)}
                </tbody>
              </table>
            </DiffSection>
          )}

          {/* Operator changes */}
          {diff.operatorChanges.length > 0 && (
            <DiffSection title="Operators / approvals" count={diff.operatorChanges.length}>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Before</th>
                    <th></th>
                    <th>After</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.operatorChanges.map((d, i) => <OperatorRow key={i} diff={d} />)}
                </tbody>
              </table>
            </DiffSection>
          )}

          {/* Permission changes */}
          {diff.permissionChanges.length > 0 && (
            <DiffSection title="Contract permissions" count={diff.permissionChanges.length}>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Permission</th>
                    <th>Before</th>
                    <th></th>
                    <th>After</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.permissionChanges.map((d, i) => <PermissionRow key={i} diff={d} />)}
                </tbody>
              </table>
            </DiffSection>
          )}

          {/* Recipient exposure */}
          {diff.recipientExposure.length > 0 && (
            <DiffSection title="Destination exposure" count={diff.recipientExposure.length}>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Before</th>
                    <th></th>
                    <th>Sent</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.recipientExposure.map((e, i) => <RecipientRow key={i} exposure={e} />)}
                </tbody>
              </table>
            </DiffSection>
          )}

          {diff.balanceChanges.length === 0 &&
           diff.allowanceChanges.length === 0 &&
           diff.operatorChanges.length === 0 &&
           diff.permissionChanges.length === 0 && (
            <p className="txdiff-empty">No state changes detected for this transaction.</p>
          )}
        </>
      )}

      {!diff && !demoMode && (
        <div className="txdiff-empty">
          <p>No transaction proposed yet.</p>
        </div>
      )}
    </section>
  )
}
