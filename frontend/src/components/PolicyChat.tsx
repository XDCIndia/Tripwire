/**
 * Issue #20: Natural-language policy setting
 *
 * Acceptance criteria:
 * 1. Free-text input for natural language policy descriptions
 * 2. Local parser converts natural language into Guard config struct
 *    (limit, delay window, allowlist behavior)
 * 3. Parsed config shown to owner for confirmation before on-chain submission
 */
import { useState } from "react"
import { useAccount, useWriteContract } from "wagmi"

import { activeChain, deployment } from "../config.js"
import { type ParsedPolicy, parsePolicy, formatDuration, formatWei } from "../policyParser.js"

// The write ABI for setLimits — the only on-chain mutation this component makes.
import { GUARD_WRITE_ABI } from "../guardAbi.js"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PolicyChat() {
  const [input, setInput] = useState("")
  const [parsed, setParsed] = useState<ParsedPolicy | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const { isConnected } = useAccount()
  const { writeContract, isPending } = useWriteContract()

  function handleParse() {
    if (!input.trim()) return
    setParsed(parsePolicy(input))
    setSubmitted(false)
  }

  function handleConfirm() {
    if (!parsed || !deployment.guardAddress) return
    writeContract(
      {
        address: deployment.guardAddress,
        abi: GUARD_WRITE_ABI,
        functionName: "setLimits",
        args: [
          parsed.perTxLimit ? BigInt(parsed.perTxLimit) : 0n,
          parsed.rollingLimit ? BigInt(parsed.rollingLimit) : 0n,
        ],
        chainId: activeChain.id,
      },
      {
        onSuccess: () => setSubmitted(true),
      },
    )
  }

  return (
    <section className="card policy-chat">
      <h2>Policy Settings</h2>
      <p className="policy-description">
        Describe your security policy in plain English. The parser converts it into on-chain Guard
        configuration.
      </p>

      {/* Criterion 1: Free-text input */}
      <div className="policy-input-row">
        <input
          type="text"
          className="policy-input"
          placeholder='e.g. "limit $500 per tx, $5000 per day, delay 30 minutes"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleParse()}
        />
        <button type="button" className="policy-parse-btn" onClick={handleParse} disabled={!input.trim()}>
          Parse
        </button>
      </div>

      {/* Criterion 2 & 3: Parsed config shown for confirmation */}
      {parsed && (
        <div className="policy-preview">
          <h3>Parsed Configuration</h3>
          <dl className="kv">
            <dt>Per-tx limit</dt>
            <dd>{parsed.perTxLimit ? formatWei(parsed.perTxLimit) : "disabled"}</dd>
            <dt>Daily rolling limit</dt>
            <dd>{parsed.rollingLimit ? formatWei(parsed.rollingLimit) : "disabled"}</dd>
            <dt>Delay window</dt>
            <dd>{parsed.delayWindow ? formatDuration(parsed.delayWindow) : "none"}</dd>
            <dt>Interpretation</dt>
            <dd>{parsed.explanation}</dd>
          </dl>

          {isConnected && deployment.guardAddress && (
            <div className="policy-actions">
              {submitted ? (
                <span className="pill pill-active">Submitted ✓</span>
              ) : (
                <button
                  type="button"
                  className="policy-confirm-btn"
                  onClick={handleConfirm}
                  disabled={isPending || (!parsed.perTxLimit && !parsed.rollingLimit)}
                >
                  {isPending ? "Confirming…" : "Confirm & Submit On-Chain"}
                </button>
              )}
            </div>
          )}

          {!isConnected && (
            <p className="policy-note">Connect your wallet to submit this policy on-chain.</p>
          )}
        </div>
      )}
    </section>
  )
}
