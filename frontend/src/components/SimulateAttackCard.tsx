import { useEffect, useState } from "react"
import { encodeFunctionData } from "viem"

import { deployment } from "../config.js"
import { ERC721_ABI } from "../ercAbis.js"

/**
 * Issue #19: the demo-stage "simulate attack" button. One click proposes
 * the drainer's real payload - setApprovalForAll(attacker, true) on the
 * demo NFT - to the backend orchestrator (issue #45/#102) for scoring. No
 * terminal on stage.
 *
 * POSTs `{ to, value, data }` to the trigger endpoint
 * (`VITE_ATTACK_TRIGGER_URL`, or `<VITE_BACKEND_URL>/tx/propose` by
 * default) - the exact shape orchestratorHttp.ts's POST /tx/propose
 * expects. Requires VITE_NFT_ADDRESS and VITE_ATTACKER_ADDRESS to be
 * configured (scripts/localDeploy.ts / deployTestnet.ts output) so there's
 * a real contract to build the calldata against.
 *
 * Once the orchestrator scores it, the verdict appears in the live risk
 * feed (issue #17, polling) within seconds - that's the visible reaction
 * this button is for.
 *
 * Guarded with a cooldown so an excited stage demo cannot double-fire.
 * Inert with a setup hint when the trigger URL or the target addresses
 * aren't configured.
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

  const { nftAddress, attackerAddress } = deployment
  const armed = Boolean(triggerUrl && nftAddress && attackerAddress)

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
    if (state === "firing" || coolingDown || !nftAddress || !attackerAddress) return
    setState("firing")
    setLastError(undefined)
    try {
      const data = encodeFunctionData({
        abi: ERC721_ABI,
        functionName: "setApprovalForAll",
        args: [attackerAddress, true],
      })
      const res = await fetch(triggerUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: nftAddress, value: "0", data }),
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
      {!armed ? (
        <p className="sim-note">
          Set VITE_BACKEND_URL, VITE_NFT_ADDRESS, and VITE_ATTACKER_ADDRESS to arm the drainer trigger.
        </p>
      ) : (
        <>
          <p className="attack-desc">
            Propose setApprovalForAll on the demo NFT to the risk orchestrator and watch the live risk feed react.
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
                    : "Propose drainer approval to demo Safe"}
          </button>
          {state === "fired" && !coolingDown ? (
            <p className="attack-ok">Proposed - watch the risk feed for the resulting verdict.</p>
          ) : null}
          {state === "error" ? <p className="sim-warning">⚠️ Trigger failed: {lastError}</p> : null}
        </>
      )}
    </section>
  )
}
