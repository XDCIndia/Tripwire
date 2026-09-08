/* ---------------------------------------------------------------------------
   The dashboard's pages, in one place.

   The sidebar, the router in App and the command palette all read this, so a
   page cannot exist in the nav and nowhere else, or be reachable by search but
   missing from the sidebar.
   --------------------------------------------------------------------------- */
import type { ReactElement } from "react"

import {
  IconDemo,
  IconInvestigate,
  IconMonitor,
  IconOverview,
  IconPolicy,
  IconTrail,
} from "./navIcons.js"

export type PageTone = "live" | "sample"

export interface PageDef {
  id: string
  title: string
  /** Shown as the page's own lead paragraph, and nowhere else. */
  blurb: string
  /** Whether the numbers on this page come off the chain or out of a fixture. */
  tone: PageTone
  /** The provenance line under the page title. */
  source: string
  icon: (p: { className?: string }) => ReactElement
  /** How many cards the page holds — shown in the sidebar. */
  cards: number
}

export const PAGES: PageDef[] = [
  {
    id: "overview",
    title: "Overview",
    blurb:
      "Everything on one page, in the order a transaction meets it. Each group below says where its numbers come from.",
    tone: "live",
    source: "Mixed — each section is labelled",
    icon: IconOverview,
    // Filled in below from the pages it stacks, so it cannot drift when a card
    // moves between sections -- it already had, once.
    cards: 0,
  },
  {
    id: "monitoring",
    title: "Live monitoring",
    blurb:
      "What is being watched right now: the Safe, the Guard protecting it, and every transaction the risk engine has scored.",
    tone: "live",
    source: "Live — this wallet and the risk engine",
    icon: IconMonitor,
    cards: 4,
  },
  {
    id: "decisions",
    title: "Decision trail",
    blurb:
      "Why each verdict came out the way it did. The audit trail records the decision; the simulation records what the transaction would actually have done.",
    tone: "live",
    source: "Live — recorded verdicts and simulations",
    icon: IconTrail,
    cards: 2,
  },
  {
    id: "policy",
    title: "Policy",
    blurb:
      "The rules the Guard enforces on-chain. Spending limits hold whether or not the risk engine is running.",
    tone: "live",
    source: "Live — the Guard's on-chain configuration",
    icon: IconPolicy,
    cards: 2,
  },
  {
    id: "investigation",
    title: "Investigation",
    blurb:
      "Tools for taking one transaction apart. These are built against fixed examples and are not reading live transactions yet.",
    tone: "sample",
    source: "Sample data — not reading live transactions",
    icon: IconInvestigate,
    cards: 5,
  },
  {
    id: "demo",
    title: "Demo controls",
    blurb:
      "Sends a real transaction into the pipeline so the whole path can be watched end to end.",
    tone: "sample",
    source: "Sends a real transaction into the pipeline",
    icon: IconDemo,
    cards: 1,
  },
]

export interface NavGroup {
  heading?: string
  tone?: PageTone
  pages: PageDef[]
}

PAGES[0].cards = PAGES.slice(1).reduce((n, p) => n + p.cards, 0)

const byId = (id: string) => PAGES.find((p) => p.id === id)!

/**
 * Grouped by provenance rather than by feature. The one thing a reader most
 * needs to know before trusting a number on this screen is whether it came off
 * the chain, so that is what the sidebar is organised around.
 */
export const NAV_GROUPS: NavGroup[] = [
  { pages: [byId("overview")] },
  {
    heading: "Live",
    tone: "live",
    pages: [byId("monitoring"), byId("decisions"), byId("policy")],
  },
  {
    heading: "Sample data",
    tone: "sample",
    pages: [byId("investigation"), byId("demo")],
  },
]
