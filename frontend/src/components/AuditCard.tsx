import { useQuery } from "@tanstack/react-query"

/**
 * Issue #52's investigation surface: the risk-decision audit ledger. Lists
 * reconstructed audit records (canonical decision, enforcement, and
 * reconciliation status per transaction) from the backend's read-only
 * audit API, so an investigator can see WHY a decision happened and WHAT
 * happened afterward without leaving the dashboard.
 *
 * Inert with a setup hint when no backend URL is configured.
 */

interface CanonicalDto {
  score: number
  status: string
  action: string
  explanation: string
  at: string
  policyVersion: string
  ruleVersion: string
}

interface EnforcementDto {
  enforcementTxHash?: string
  status: "submitted" | "confirmed" | "failed"
  attempts: number
}

interface ReconciliationDto {
  expected: string
  actual: string
  status: "match" | "mismatch" | "pending"
}

interface AnalysisEvidenceDto {
  ruleEngine?: { at: string; result: Record<string, unknown> }
  simulation?: { at: string; result: Record<string, unknown> }
  llm?: { at: string; result: Record<string, unknown> }
  wallet?: { at: string; result: Record<string, unknown> }
}

interface AuditRecordDto {
  txHash: string
  safe: string
  verdictId?: string
  policyVersion: string
  ruleVersion: string
  updatedAt: string
  canonical?: CanonicalDto
  enforcement?: EnforcementDto
  reconciliation?: ReconciliationDto
  analysis: AnalysisEvidenceDto
  eventCount: number
}

const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined

async function fetchAuditRecords(): Promise<AuditRecordDto[]> {
  const res = await fetch(`${backendUrl}/audit?limit=5`)
  if (!res.ok) throw new Error(`audit endpoint returned ${res.status}`)
  return (await res.json()) as AuditRecordDto[]
}

function shorten(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

function statusPillClass(status?: string): string {
  if (status === "high_risk" || status === "failed" || status === "mismatch") return "pill-frozen"
  if (status === "medium_risk" || status === "submitted" || status === "pending") return "pill-warn"
  return "pill-active"
}

function AuditEntry({ record }: { record: AuditRecordDto }) {
  const evidence = [
    record.analysis.ruleEngine ? "rules" : undefined,
    record.analysis.simulation ? "sim" : undefined,
    record.analysis.llm ? "llm" : undefined,
    record.analysis.wallet ? "wallet" : undefined,
  ].filter(Boolean)

  return (
    <div className="sim-entry">
      <div className="sim-head">
        <span className="mono">{shorten(record.txHash)}</span>
        <span className={`pill ${statusPillClass(record.canonical?.status)}`}>
          {record.canonical ? `${record.canonical.status} · ${record.canonical.action}` : "undecided"}
        </span>
      </div>
      <dl className="kv">
        <dt>Score</dt>
        <dd>{record.canonical ? `${record.canonical.score}/100` : "—"}</dd>
        <dt>Why</dt>
        <dd>{record.canonical?.explanation || "—"}</dd>
        <dt>Versions</dt>
        <dd className="mono">
          {record.policyVersion} / {record.ruleVersion}
        </dd>
        <dt>Evidence</dt>
        <dd>{evidence.length > 0 ? evidence.join(" + ") : "none recorded"}</dd>
        <dt>Enforcement</dt>
        <dd>
          {record.enforcement ? (
            <span className={`pill ${statusPillClass(record.enforcement.status)}`}>
              {record.enforcement.status}
              {record.enforcement.attempts > 1 ? ` (${record.enforcement.attempts} attempts)` : ""}
            </span>
          ) : (
            "—"
          )}
        </dd>
        <dt>On-chain</dt>
        <dd>
          {record.reconciliation ? (
            <span className={`pill ${statusPillClass(record.reconciliation.status)}`}>
              {record.reconciliation.status}
            </span>
          ) : (
            "—"
          )}
        </dd>
      </dl>
    </div>
  )
}

export function AuditCard() {
  const enabled = Boolean(backendUrl)
  const query = useQuery({
    queryKey: ["audit", "latest"],
    queryFn: fetchAuditRecords,
    refetchInterval: 5000,
    enabled,
  })

  return (
    <section className="card">
      <h2>Decision audit ledger</h2>
      {!enabled ? (
        <p className="sim-note">Set VITE_BACKEND_URL to stream audit records from the watcher.</p>
      ) : query.isLoading ? (
        "Loading…"
      ) : query.isError ? (
        <p className="sim-warning">⚠️ Audit endpoint unreachable</p>
      ) : query.data && query.data.length > 0 ? (
        query.data.map((record) => <AuditEntry key={record.txHash} record={record} />)
      ) : (
        <p className="sim-note">No audited transactions yet.</p>
      )}
    </section>
  )
}
