/**
 * Issue #20: Natural-language policy setting
 *
 * Acceptance criteria:
 * 1. Free-text input for natural language policy descriptions
 * 2. Parsed into the Guard config struct (limit, delay window, allowlist behavior)
 * 3. Parsed config shown to owner for confirmation before on-chain submission
 *
 * Criterion 2 is served by the backend compiler (`POST /policy/compile`), not a
 * second parser in the browser. There used to be one here, and it read the same
 * sentence differently: given the project's own example policy it silently
 * dropped the delay clause and re-read the freeze threshold as a daily limit.
 * One grammar, one validator, one set of errors - the dashboard and the
 * enforcement path cannot disagree about what a policy means.
 */
import { useState } from "react"
import { useAccount, useSwitchChain, useWriteContract } from "wagmi"

import { activeChain, deployment } from "../config.js"

// The write ABI for setLimits — the only on-chain mutation this component makes.
import { GUARD_WRITE_ABI } from "../guardAbi.js"

const configuredPolicy = import.meta.env.VITE_POLICY_URL as string | undefined
const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined
/** VITE_POLICY_URL wins; otherwise /policy/compile on the orchestrator. */
const policyUrl: string | undefined =
  configuredPolicy ?? (backendUrl ? `${backendUrl}/policy/compile` : undefined)

/** Mirrors the compiler's response. Wei values arrive as decimal strings. */
interface CompiledPolicyDto {
  source: string
  explanation: string
  rules: Array<{ source: string }>
  guardConfig: {
    perTxLimit: string
    rollingLimit: string
    defaultDelaySeconds: number | null
  }
}

interface CompileError {
  error: string
  issues?: string[]
}

/** Wei → a short decimal string. Native units, not dollars. */
function formatWei(wei: string): string {
  const n = BigInt(wei)
  if (n === 0n) return "0"
  const whole = n / 10n ** 18n
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac.slice(0, 4)}` : whole.toString()
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600
    return `${h} hour${h === 1 ? "" : "s"}`
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60
    return `${m} minute${m === 1 ? "" : "s"}`
  }
  return `${seconds} seconds`
}

export function PolicyChat() {
  const [input, setInput] = useState("")
  // Required whenever a rule names a fiat amount. The compiler refuses to
  // guess a rate rather than silently assuming $1 = 1 native token.
  const [usdPerNative, setUsdPerNative] = useState("1")
  const [compiled, setCompiled] = useState<CompiledPolicyDto | null>(null)
  const [error, setError] = useState<CompileError | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const { isConnected, chainId: walletChainId } = useAccount()
  const { writeContract, error: submitError, isPending, reset: resetSubmit } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()

  async function handleCompile(): Promise<void> {
    if (!input.trim() || !policyUrl) return
    setCompiling(true)
    setError(null)
    setCompiled(null)
    setSubmitted(false)
    try {
      const res = await fetch(policyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input, usdPerNative }),
      })
      const body = (await res.json()) as CompiledPolicyDto | CompileError
      if (!res.ok) {
        setError(body as CompileError)
        return
      }
      setCompiled(body as CompiledPolicyDto)
    } catch (err) {
      setError({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setCompiling(false)
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!compiled || !deployment.guardAddress) return
    resetSubmit()
    // wagmi refuses cross-chain writes; prompt the switch first so a wallet
    // sitting on another network (e.g. Apothem) gets one MetaMask "Switch
    // to Hardhat?" prompt instead of a dead click + mismatch error.
    if (walletChainId !== activeChain.id) {
      try {
        await switchChainAsync({ chainId: activeChain.id })
      } catch {
        return // wallet declined the switch - MetaMask already explained
      }
    }
    writeContract(
      {
        address: deployment.guardAddress,
        abi: GUARD_WRITE_ABI,
        functionName: "setLimits",
        args: [BigInt(compiled.guardConfig.perTxLimit), BigInt(compiled.guardConfig.rollingLimit)],
        chainId: activeChain.id,
      },
      { onSuccess: () => setSubmitted(true) },
    )
  }

  const guard = compiled?.guardConfig
  const nothingToSubmit = guard ? BigInt(guard.perTxLimit) === 0n && BigInt(guard.rollingLimit) === 0n : true

  return (
    <section className="card policy-chat">
      <h2>Policy Settings</h2>
      <p className="policy-description">
        Describe your security policy in plain English. It is compiled by the same engine that
        enforces it, so what you see here is what the Guard will do.
      </p>

      {!policyUrl ? (
        <p className="sim-note">Set VITE_POLICY_URL (or VITE_BACKEND_URL) to compile policies.</p>
      ) : (
        <>
          <div className="policy-input-row">
            <input
              type="text"
              className="policy-input"
              placeholder='e.g. "Allow payments below $500 to previously used addresses. Delay everything else for 1 hour."'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCompile()}
            />
            <button
              type="button"
              className="policy-parse-btn"
              onClick={() => void handleCompile()}
              disabled={!input.trim() || compiling}
            >
              {compiling ? "Compiling…" : "Compile"}
            </button>
          </div>

          <label className="policy-rate">
            USD per native token
            <input
              type="text"
              className="policy-rate-input"
              value={usdPerNative}
              onChange={(e) => setUsdPerNative(e.target.value)}
            />
            <span className="policy-note">Required for any policy written in dollars.</span>
          </label>

          {error && (
            <div className="policy-error">
              <p className="sim-warning">⚠️ {error.error}</p>
              {error.issues && (
                <ul>
                  {error.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {compiled && guard && (
            <div className="policy-preview">
              <h3>Compiled Policy</h3>
              <pre className="policy-explanation">{compiled.explanation}</pre>

              <dl className="kv">
                <dt>Per-tx limit</dt>
                <dd>
                  {BigInt(guard.perTxLimit) === 0n ? "disabled" : `${formatWei(guard.perTxLimit)} native`}
                </dd>
                <dt>Rolling 24h limit</dt>
                <dd>
                  {BigInt(guard.rollingLimit) === 0n
                    ? "disabled — the policy grammar has no daily-limit construct yet"
                    : `${formatWei(guard.rollingLimit)} native`}
                </dd>
                <dt>Delay window</dt>
                <dd>
                  {guard.defaultDelaySeconds === null
                    ? "none"
                    : formatDuration(guard.defaultDelaySeconds)}
                </dd>
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
                      disabled={isPending || nothingToSubmit}
                    >
                      {isPending ? "Confirming…" : "Confirm & Submit On-Chain"}
                    </button>
                  )}
                  {/* A failed writeContract (rejection, locked wallet, wrong
                      network) used to vanish silently - the click looked dead. */}
                  {submitError && (
                    <p className="sim-warning" role="alert">
                      ⚠️ On-chain submit failed: {submitError.message}
                    </p>
                  )}
                </div>
              )}

              {nothingToSubmit && (
                <p className="policy-note">
                  This policy sets no on-chain limit. The delay window is applied by the relayer
                  per verdict, not by <code>setLimits</code>.
                </p>
              )}

              {!isConnected && (
                <p className="policy-note">Connect your wallet to submit this policy on-chain.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
