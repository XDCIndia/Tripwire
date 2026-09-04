import { Fragment } from "react"
import { useQuery } from "@tanstack/react-query"

/**
 * Issue #44's dashboard surface: renders the state changes the backend's
 * fork simulation detected (balances, allowances, NFT ownership) plus the
 * derived risk signals. Data comes from the backend's read-only sim
 * endpoint (`backend/src/simHttp.ts`) - bigints arrive as decimal strings.
 *
 * The card is inert when no backend URL is configured, so the existing
 * Safe/Guard cards keep working standalone.
 */

interface AllowanceChangeDto {
  token: string
  spender: string
  standard: "erc20" | "nft"
  before: string
  after: string
}

interface OwnershipChangeDto {
  token: string
  tokenId: string
  ownerBefore: string
  ownerAfter: string
}

interface SimulationDiffDto {
  balanceBefore: string
  balanceAfter: string
  newAllowances: AllowanceChangeDto[]
  ownershipChanges: OwnershipChangeDto[]
  success: boolean
}

interface SimulationSignalsDto {
  simulationFailed: boolean
  callReverted: boolean
  hiddenNativeOutflow: boolean
  unexpectedAllowanceIncrease: boolean
  ownershipTransferDetected: boolean
}

interface RecordedSimulationDto {
  txHash: string
  safe: string
  to: string
  at: string
  diff?: SimulationDiffDto
  signals: SimulationSignalsDto
}

const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined

async function fetchLatestSimulations(): Promise<RecordedSimulationDto[]> {
  const res = await fetch(`${backendUrl}/simulations/latest?limit=5`)
  if (!res.ok) throw new Error(`sim endpoint returned ${res.status}`)
  return (await res.json()) as RecordedSimulationDto[]
}

function shorten(address: string): string {
  return address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address
}

function firedWarnings(signals: SimulationSignalsDto): string[] {
  const warnings: string[] = []
  if (signals.simulationFailed) warnings.push("⚠️ Simulation could not run - treated as elevated risk")
  if (signals.callReverted) warnings.push("⚠️ Call reverts on a fork - calldata doesn't do what it claims")
  if (signals.hiddenNativeOutflow) warnings.push("⚠️ Balance drops beyond the stated value - hidden outflow")
  if (signals.unexpectedAllowanceIncrease) warnings.push("⚠️ Concealed allowance change detected")
  if (signals.ownershipTransferDetected) warnings.push("⚠️ An owned NFT leaves the wallet in this transaction")
  return warnings
}

function SimulationEntry({ entry }: { entry: RecordedSimulationDto }) {
  const warnings = firedWarnings(entry.signals)
  const diff = entry.diff
  const rows: Array<{ term: string; detail: string }> = diff
    ? [
        { term: "Balance", detail: `${diff.balanceBefore} → ${diff.balanceAfter} wei` },
        ...diff.newAllowances.map((a) => ({
          term: "Allowance",
          detail: `${a.standard} ${shorten(a.token)} → ${shorten(a.spender)}: ${a.before} ⇒ ${a.after}`,
        })),
        ...diff.ownershipChanges.map((o) => ({
          term: "NFT moved",
          detail: `${shorten(o.token)} #${o.tokenId}: ${shorten(o.ownerBefore)} → ${shorten(o.ownerAfter)}`,
        })),
      ]
    : []

  return (
    <div className="sim-entry">
      <div className="sim-head">
        <span className="mono">{shorten(entry.txHash)}</span>
        <span className={`pill ${diff?.success === false ? "pill-frozen" : "pill-active"}`}>
          {diff ? (diff.success ? "replayed" : "reverted") : "unverified"}
        </span>
      </div>
      {rows.length > 0 && (
        <dl className="kv">
          {rows.map((row, i) => (
            <Fragment key={i}>
              <dt>{row.term}</dt>
              <dd className="mono">{row.detail}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {warnings.map((w) => (
        <p key={w} className="sim-warning">
          {w}
        </p>
      ))}
    </div>
  )
}

export function SimulationCard() {
  const enabled = Boolean(backendUrl)
  const query = useQuery({
    queryKey: ["simulations", "latest"],
    queryFn: fetchLatestSimulations,
    refetchInterval: 5000,
    enabled,
  })

  return (
    <section className="card">
      <h2>Simulation impact</h2>
      {!enabled ? (
        <p className="sim-note">Set VITE_BACKEND_URL to stream fork-simulation results from the watcher.</p>
      ) : query.isLoading ? (
        "Loading…"
      ) : query.isError ? (
        <p className="sim-warning">⚠️ Simulation endpoint unreachable</p>
      ) : query.data && query.data.length > 0 ? (
        query.data.map((entry) => <SimulationEntry key={entry.txHash} entry={entry} />)
      ) : (
        <p className="sim-note">No simulations recorded yet.</p>
      )}
    </section>
  )
}
