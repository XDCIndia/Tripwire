import { useEffect, useState } from "react"

/**
 * Issue #19: the demo-stage "simulate attack" button. One click fires the
 * backend drainer script against the demo Safe - no terminal on stage.
 *
 * Trigger contract: POST a proposed transaction to the trigger endpoint
 * (`VITE_ATTACK_TRIGGER_URL`, or `<VITE_BACKEND_URL>/tx/propose` as the
 * default) in the `{ to, value, data }` shape the orchestrator's intake
 * requires. The tx flows through the scoring pipeline and surfaces in the
 * live risk feed (issue #17, 4s poll) within seconds - that is the visible
 * reaction this button is for.
 *
 * Guarded with a cooldown so an excited stage demo cannot double-fire.
 * Inert with a setup hint when no trigger URL is configured.
 */

type FireState = "idle" | "firing" | "fired" | "error"

const configuredTrigger = import.meta.env.VITE_ATTACK_TRIGGER_URL as string | undefined
const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined
/** VITE_ATTACK_TRIGGER_URL wins; otherwise POST to /tx/propose on the orchestrator. */
const triggerUrl: string | undefined = configuredTrigger ?? (backendUrl ? `${backendUrl}/tx/propose` : undefined)

const COOLDOWN_MS = 5000

/**
 * The drainer payload the orchestrator scores: `setApprovalForAll(operator, true)`,
 * which grants blanket control of an entire NFT collection. Selector 0xa22cb465 is
 * exactly what `ruleEngine.ts` weights hardest, so this round-trips into a high-risk
 * verdict rather than a shrug.
 *
 * Sent as the real `{ to, value, data }` the intake endpoint requires. A fresh
 * operator address per click keeps the derived txHash unique, so repeat demo runs
 * produce new feed rows instead of deduping into the first one.
 */
const SET_APPROVAL_FOR_ALL = "0xa22cb465"

function randomAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

function encodeAddress(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0")
}

/** A malicious NFT collection is the target; the attacker is the operator being approved. */
function buildDrainerTx(): { to: string; value: string; data: string } {
  const approvedTrue = "1".padStart(64, "0")
  return {
    to: randomAddress(),
    value: "0",
    data: `${SET_APPROVAL_FOR_ALL}${encodeAddress(randomAddress())}${approvedTrue}`,
  }
}

export function SimulateAttackCard() {
  const [state, setState] = useState<FireState>("idle")
  const [coolingDown, setCoolingDown] = useState(false)
  const [lastError, setLastError] = useState<string | undefined>(undefined)

  // Re-arm the button once the cooldown expires.
  useEffect(() => {
    if (!coolingDown) return
    const timer = setTimeout(() => {
      setCoolingDown(false)
      setState("idle")
    }, COOLDOWN_MS)
    return () => clearTimeout(timer)
  }, [coolingDown])

  async function fire(): Promise<void> {
    if (state === "firing" || coolingDown) return
    setState("firing")
    setLastError(undefined)
    try {
      const res = await fetch(triggerUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildDrainerTx()),
      })
      if (!res.ok) throw new Error(`trigger returned ${res.status}`)
      setState("fired")
      setCoolingDown(true)
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
      setState("error")
    }
  }

  return (
    <section className="card attack-card">
      <h2>Demo attack</h2>
      {!triggerUrl ? (
        <p className="sim-note">Set VITE_ATTACK_TRIGGER_URL (or VITE_BACKEND_URL) to arm the drainer trigger.</p>
      ) : (
        <>
          <p className="attack-desc">
            Fire the drainer script against the demo Safe and watch the live risk feed react.
          </p>
          <button
            type="button"
            className={`attack-btn ${state === "fired" ? "attack-btn-fired" : ""}`}
            onClick={() => void fire()}
            disabled={state === "firing" || coolingDown}
          >
            {state === "firing"
              ? "Firing…"
              : coolingDown
                ? "Arming…"
                : state === "fired"
                  ? "Attack launched ✓"
                  : state === "error"
                    ? "Retry attack"
                    : "Run drainer against demo Safe"}
          </button>
          {state === "fired" && !coolingDown ? (
            <p className="attack-ok">Drainer triggered - watch the risk feed for new verdicts.</p>
          ) : null}
          {state === "error" ? <p className="sim-warning">⚠️ Trigger failed: {lastError}</p> : null}
        </>
      )}
    </section>
  )
}
