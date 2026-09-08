/* ---------------------------------------------------------------------------
   The dashboard's icons.


   Icons are inline geometry rather than an icon package. The landing page draws
   its own — abstract shapes at a hairline stroke — and pulling in a set of
   pictograms here would be the one thing on the screen that came from somewhere
   else. It also keeps a dependency out of the bundle for six glyphs.
   --------------------------------------------------------------------------- */

type IconProps = { className?: string }

const S = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
}

/** Four panes: everything at once. */
export function IconOverview(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <rect x="3" y="3" width="7.5" height="7.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" />
    </svg>
  )
}

/** Concentric rings: something being watched, live. */
export function IconMonitor(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="6.5" opacity="0.6" />
      <circle cx="12" cy="12" r="10" opacity="0.3" />
    </svg>
  )
}

/** A ledger: decisions, recorded in order. */
export function IconTrail(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <path d="M4 6h16" />
      <path d="M4 12h16" opacity="0.6" />
      <path d="M4 18h10" opacity="0.35" />
    </svg>
  )
}

/** A gate with a rule through it: the policy the Guard enforces. */
export function IconPolicy(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <path d="M5 4v16" />
      <path d="M19 4v16" />
      <path d="M5 12h14" />
      <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** A lens: tools for looking at one transaction closely. */
export function IconInvestigate(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
    </svg>
  )
}

/** A trigger: fires a real transaction into the pipeline. */
export function IconDemo(p: IconProps) {
  return (
    <svg {...S} {...p}>
      <path d="M13 3 5 13.5h6L11 21l8-10.5h-6z" />
    </svg>
  )
}

