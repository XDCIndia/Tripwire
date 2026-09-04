import { useContractVerification, type ContractVerification } from "../contractVerifier.js"

/**
 * Issue #94: Contract Verification Status Card
 *
 * Shows per-contract verification status (Safe, Guard, RiskRegistry) with
 * explicit states: NOT_CONFIGURED, NOT_DEPLOYED, INTERFACE_MISMATCH,
 * READ_FAILED, VERIFIED. Never converts failure states into PROTECTED.
 */

function statusIcon(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "✓"
    case "NOT_CONFIGURED":
      return "○"
    default:
      return "✕"
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "verify-ok"
    case "NOT_CONFIGURED":
      return "verify-unset"
    default:
      return "verify-fail"
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "Verified"
    case "NOT_CONFIGURED":
      return "Not configured"
    case "NOT_DEPLOYED":
      return "Not deployed"
    case "INTERFACE_MISMATCH":
      return "Interface mismatch"
    case "READ_FAILED":
      return "Read failed"
    default:
      return status
  }
}

function ContractRow({ label, verification }: { label: string; verification: ContractVerification }) {
  const cls = statusClass(verification.status)
  return (
    <div className={`verify-row ${cls}`}>
      <div className="verify-label">
        <span className="verify-icon">{statusIcon(verification.status)}</span>
        <span className="verify-name">{label}</span>
        <span className="verify-status">{statusLabel(verification.status)}</span>
      </div>
      <p className="verify-detail">{verification.detail}</p>
    </div>
  )
}

export function VerificationStatusCard() {
  const { report, isVerifying, reverify } = useContractVerification()

  return (
    <section className="card verify-card">
      <div className="verify-header">
        <h2>Contract verification</h2>
        <button type="button" className="verify-refresh" onClick={reverify} disabled={isVerifying}>
          {isVerifying ? "Verifying…" : "Re-verify"}
        </button>
      </div>

      {!report ? (
        <p className="verify-loading">Verifying contracts on {report === null ? "active network" : "…"}…</p>
      ) : (
        <>
          <div className="verify-contracts">
            <ContractRow label="Safe" verification={report.safe} />
            <ContractRow label="Guard" verification={report.guard} />
            <ContractRow label="Risk Registry" verification={report.riskRegistry} />
          </div>

          <div className={`verify-protection ${report.protectionStatus === "PROTECTED" ? "verify-protected" : "verify-unprotected"}`}>
            <span className="verify-protection-label">Protection status</span>
            <span className="verify-protection-value">
              {report.protectionStatus === "PROTECTED" ? "PROTECTED" : "UNVERIFIED"}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
