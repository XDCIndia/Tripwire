import type { ReactNode } from "react"
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
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

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
          onClick={() => connect({ connector })}
        >
          <RollLabel>{isPending ? "Connecting…" : `Connect ${connector.name}`}</RollLabel>
        </button>
      ))}
    </div>
  )
}
