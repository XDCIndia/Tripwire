import { useEffect, useState } from "react"

/**
 * Issue #19: the demo-stage "simulate attack" button. One click fires the
 * backend drainer script against the demo Safe - no terminal on stage.
 *
 * Trigger contract: POST to the trigger endpoint
 * (`VITE_ATTACK_TRIGGER_URL`, or `<VITE_BACKEND_URL>/simulate/attack` as
 * the default). The backend drainer-script issue owns what happens next;
 * this card only needs the endpoint to accept the POST and start the
 * script, returning 2xx. Once the drainer lands, the attack transactions
 * flow through the watcher -> verdict pipeline and appear in the live
 * risk feed (issue #17, 4s poll) within seconds - that is the visible
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
        body: JSON.stringify({ target: "demo-safe" }),
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
