import type { ReactNode } from "react"
import { useRef } from "react"
import { useAccount, useConnect, useDisconnect } from "wagmi"

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * The landing page's CTA label treatment: two stacked copies of the text, the
 * visible one sliding out the top while a duplicate rises into its place on
 * hover. Mirrors site/src/components/TextRoll.tsx — in CSS rather than motion,
 * because the dashboard does not carry an animation library for one control.
 */
function RollLabel({ children }: { children: ReactNode }) {
  return (
    <span className="cta-roll">
      <span className="cta-roll-out">{children}</span>
      {/* Hidden from assistive tech so the label is not announced twice. */}
      <span className="cta-roll-in" aria-hidden="true">
        {children}
      </span>
    </span>
  )
}

/**
 * Wallet connection, wearing the site's two CTAs: connecting is the solid
 * "View Dashboard" button, and the connected pair is the outlined "View Docs"
 * one — the address as a static chip, disconnecting as the only live action.
 */
export function ConnectWallet() {
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors, error, isPending, reset } = useConnect()
  const { disconnect } = useDisconnect()
  // Synchronous re-click guard. `disabled={isPending}` is not enough: React
  // applies it a tick after the click, and MetaMask rejects a second
  // wallet_requestPermissions while one is still open with "already pending".
  const busy = useRef(false)

  if (isConnected && address) {
    return (
      <div className="connect-wallet">
        <span className="cta cta-ghost cta-static mono" title={address}>
          {short(address)}
        </span>
        <button type="button" className="cta cta-ghost" onClick={() => disconnect()}>
          <RollLabel>Disconnect</RollLabel>
        </button>
      </div>
    )
  }

  return (
    <div className="connect-wallet">
      {connectors.map((connector) => (
        <button
          type="button"
          key={connector.uid}
          className="cta cta-primary"
          disabled={isPending}
          onClick={() => {
            if (busy.current) return
            busy.current = true
            reset()
            connectAsync({ connector })
              // The mutation's error state still records the failure; this
              // catch only prevents an unhandled promise rejection.
              .catch(() => {})
              .finally(() => {
                busy.current = false
              })
          }}
        >
          <RollLabel>{isPending ? "Connecting…" : `Connect ${connector.name}`}</RollLabel>
        </button>
      ))}
      {/* aria-live so the failure is announced, not just shown — a click that
          does nothing reads as "broken" when no wallet provider answers. */}
      {error && (
        <p className="connect-error" role="alert" aria-live="polite">
          {/already pending/i.test(error.message)
            ? "A connect request is already open in your wallet — approve or reject it there first."
            : error.message}
        </p>
      )}
    </div>
  )
}
