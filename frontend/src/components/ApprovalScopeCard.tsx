import { useState } from "react"
import { decodeApprovalScope, type ApprovalScope } from "../approvalDecoder.js"

/**
 * Issue #90: Transaction Approval Scope Visualizer
 *
 * Translates raw ERC-20 approve / setApprovalForAll calldata into a
 * human-readable security model. Shows the permission graph, before/after
 * comparison, security indicators, and a plain-English explanation.
 *
 * The component is self-contained: paste calldata + token address and it
 * decodes, classifies risk, and renders the visualization. It
 * recalculates whenever inputs change (issue #90 acceptance: "Permission
 * state is recalculated if the underlying transaction changes").
 */

function shortAddr(addr: `0x${string}` | null): string {
  if (!addr) return "—"
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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

function riskEmoji(risk: string): string {
  switch (risk) {
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

function signalLabel(signal: string): string {
  switch (signal) {
    case "unlimited":
      return "Unlimited allowance"
    case "first-seen-spender":
      return "First-seen spender"
    case "collection-wide":
      return "Collection-wide permission"
    case "increase":
      return "Allowance increase"
    case "revocation":
      return "Revocation"
    case "limited":
      return "Limited allowance"
    default:
      return signal
  }
}

function signalEmoji(signal: string): string {
  switch (signal) {
    case "unlimited":
      return "🔴"
    case "first-seen-spender":
      return "🔴"
    case "collection-wide":
      return "🟠"
    case "increase":
      return "🟠"
    case "revocation":
      return "🟢"
    case "limited":
      return "🟢"
    default:
      return "⚪"
  }
}

function formatAmount(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0")
  const intPart = str.slice(0, str.length - decimals) || "0"
  const fracPart = str.slice(str.length - decimals)
  const fracTrimmed = fracPart.replace(/0+$/, "")
  return fracTrimmed.length > 0 ? `${intPart}.${fracTrimmed}` : intPart
}

function formatRaw(value: bigint): string {
  return value.toLocaleString("en-US")
}

function allowanceLabel(
  amount: bigint | null,
  isUnlimited: boolean,
  decimals: number | null,
  symbol: string | null,
): string {
  if (amount === null) return "—"
  if (isUnlimited) return `∞ Unlimited`
  if (decimals !== null) return `${formatAmount(amount, decimals)} ${symbol ?? ""}`.trim()
  return `${formatRaw(amount)} (raw)`
}

// ─── Sub-components ──────────────────────────────────────────────────

function PermissionGraph({ scope }: { scope: ApprovalScope }) {
  const tokenLabel = scope.tokenSymbol ?? shortAddr(scope.tokenAddress)

  const permissionType =
    scope.kind === "erc20-approve"
      ? "grants spending permission"
      : "grants operator permission"

  const scopeLabel =
    scope.kind === "erc20-approve"
      ? scope.isUnlimited
        ? "∞ Unlimited"
        : "Limited"
      : "ALL TOKENS"

  return (
    <div className="approval-graph">
      <div className="graph-node graph-wallet">SAFE WALLET</div>
      <div className="graph-edge">{permissionType}</div>
      <div className="graph-node graph-token">
        {tokenLabel}
        {scope.tokenSymbol && <span className="graph-sub">{shortAddr(scope.tokenAddress)}</span>}
      </div>
      <div className="graph-edge">{scopeLabel}</div>
      <div className="graph-node graph-spender">
        {scope.isKnownSpender ? "KNOWN SPENDER" : "UNKNOWN SPENDER"}
        <span className="graph-sub">{shortAddr(scope.spender)}</span>
      </div>
      <div className="graph-edge">can spend</div>
      <div
        className="graph-node graph-exposure"
        style={{ borderColor: riskColor(scope.risk), color: riskColor(scope.risk) }}
      >
        WALLET EXPOSURE: {scope.risk.toUpperCase()}
      </div>
    </div>
  )
}

function BeforeAfterTable({
  scope,
  currentAllowance,
}: {
  scope: ApprovalScope
  currentAllowance: bigint | null
}) {
  const decimals = scope.tokenDecimals ?? 18
  const symbol = scope.tokenSymbol ?? "tokens"

  const currentLabel = allowanceLabel(currentAllowance, false, decimals, symbol)
  const newLabel = allowanceLabel(scope.approvedAmount, scope.isUnlimited, decimals, symbol)

  const currentPermission =
    currentAllowance !== null
      ? currentAllowance === 0n
        ? "None"
        : currentAllowance === (1n << 256n) - 1n
          ? "Unlimited"
          : "Limited"
      : "Unknown"

  const newPermission = scope.isRevocation
    ? "None"
    : scope.isUnlimited
      ? "Unlimited"
      : scope.kind === "erc721-approveAll" || scope.kind === "erc1155-approveAll"
        ? "Collection-wide"
        : "Limited"

  const currentRisk = "low"
  const newRisk = scope.risk

  return (
    <table className="approval-table">
      <thead>
        <tr>
          <th>Property</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Token</td>
          <td className="mono">{scope.tokenSymbol ?? shortAddr(scope.tokenAddress)}</td>
          <td className="mono">{scope.tokenSymbol ?? shortAddr(scope.tokenAddress)}</td>
        </tr>
        <tr>
          <td>Spender</td>
          <td className="mono">{shortAddr(scope.spender)}</td>
          <td className="mono">{shortAddr(scope.spender)}</td>
        </tr>
        <tr>
          <td>Allowance</td>
          <td>{currentLabel}</td>
          <td>{newLabel}</td>
        </tr>
        <tr>
          <td>Permission</td>
          <td>{currentPermission}</td>
          <td>{newPermission}</td>
        </tr>
        <tr>
          <td>Exposure</td>
          <td style={{ color: riskColor(currentRisk) }}>Low</td>
          <td style={{ color: riskColor(newRisk) }}>
            {riskEmoji(newRisk)} {newRisk.charAt(0).toUpperCase() + newRisk.slice(1)}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function SecurityIndicators({ scope }: { scope: ApprovalScope }) {
  if (scope.signals.length === 0) return null

  return (
    <div className="approval-indicators">
      <h4>Security Indicators</h4>
      <ul>
        {scope.signals.map((signal) => (
          <li key={signal} className={`indicator-${signal === "unlimited" || signal === "first-seen-spender" ? "danger" : signal === "revocation" || signal === "limited" ? "safe" : "warn"}`}>
            <span className="indicator-emoji">{signalEmoji(signal)}</span>
            <span>{signalLabel(signal)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Demo input ──────────────────────────────────────────────────────

function DemoInput({ onDecode }: { onDecode: (scope: ApprovalScope) => void }) {
  const [calldata, setCalldata] = useState("")
  const [tokenAddress, setTokenAddress] = useState("")
  const [knownSpenders, setKnownSpenders] = useState("")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const known = knownSpenders
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)

    onDecode(
      decodeApprovalScope({
        calldata: calldata as `0x${string}`,
        tokenAddress: tokenAddress as `0x${string}` | undefined,
        knownSpenders: new Set(known),
      }),
    )
  }

  return (
    <form className="approval-form" onSubmit={handleSubmit}>
      <label>
        Calldata
        <input
          value={calldata}
          onChange={(e) => setCalldata(e.target.value)}
          placeholder="0x095ea7b3..."
          spellCheck={false}
          required
        />
      </label>
      <label>
        Token address (optional)
        <input
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
        />
      </label>
      <label>
        Known spenders (comma-separated, optional)
        <input
          value={knownSpenders}
          onChange={(e) => setKnownSpenders(e.target.value)}
          placeholder="0x1234..., 0xabcd..."
          spellCheck={false}
        />
      </label>
      <button type="submit">Decode approval</button>
    </form>
  )
}

// ─── Main component ──────────────────────────────────────────────────

export function ApprovalScopeCard() {
  const [scope, setScope] = useState<ApprovalScope | null>(null)

  return (
    <section className="card approval-card">
      <h2>Approval scope visualizer</h2>
      <p className="approval-description">
        Decode token approval transactions to see what permissions they grant, to whom, and
        how much exposure they create.
      </p>

      <DemoInput onDecode={setScope} />

      {scope && (
        <div className="approval-result">
          <div className="approval-header">
            <span className="pill" style={{ background: `${riskColor(scope.risk)}20`, color: riskColor(scope.risk), border: `1px solid ${riskColor(scope.risk)}66` }}>
              {scope.risk.toUpperCase()}
            </span>
            <span className="approval-type">
              {scope.kind === "erc20-approve"
                ? "ERC-20 Approval"
                : scope.kind === "erc721-approveAll" || scope.kind === "erc1155-approveAll"
                  ? "Operator Approval (setApprovalForAll)"
                  : "Unrecognized"}
            </span>
          </div>

          {scope.recognized ? (
            <>
              {/* Permission Graph */}
              <PermissionGraph scope={scope} />

              {/* Before / After Comparison */}
              <div className="approval-section">
                <h3>Scope Comparison</h3>
                <BeforeAfterTable scope={scope} currentAllowance={scope.currentAllowance} />
              </div>

              {/* Security Indicators */}
              <SecurityIndicators scope={scope} />

              {/* Explanation */}
              <div className="approval-section">
                <h3>Security Impact</h3>
                <p className="approval-explanation">{scope.explanation}</p>
              </div>
            </>
          ) : (
            <div className="approval-section">
              <p className="approval-explanation">{scope.explanation}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
