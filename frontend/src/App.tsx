import "./App.css"
import "./shell.css"

import { useCallback, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { ActionAuthCard } from "./components/ActionAuthCard.js"
import { AuditCard } from "./components/AuditCard.js"
import { AuthorizationCard } from "./components/AuthorizationCard.js"
import { BatchRiskCard } from "./components/BatchRiskCard.js"
import { CommandPalette } from "./components/CommandPalette.js"
import { ConnectWallet } from "./components/ConnectWallet.js"
import { GuardCard } from "./components/GuardCard.js"
import { NonceConflictCard } from "./components/NonceConflictCard.js"
import { PolicyChat } from "./components/PolicyChat.js"
import { PolicyPanel } from "./components/PolicyPanel.js"
import { RiskDecisionCard } from "./components/RiskDecisionCard.js"
import { RiskFeedCard } from "./components/RiskFeedCard.js"
import { SafeCard } from "./components/SafeCard.js"
import { SecurityHealthCard } from "./components/SecurityHealthCard.js"
import { SecurityTimelineCard } from "./components/SecurityTimelineCard.js"
import { Sidebar } from "./components/Sidebar.js"
import { SimulateAttackCard } from "./components/SimulateAttackCard.js"
import { SimulationCard } from "./components/SimulationCard.js"
import { SimulationIntegrityCard } from "./components/SimulationIntegrityCard.js"
import { VerificationStatusCard } from "./components/VerificationStatusCard.js"
import { SITE_URL } from "./links.js"
import { PAGES } from "./nav.js"
import { idFromLocation, pathForId } from "./route.js"

/** The cards each page owns. Kept beside the router so the two cannot drift. */
const PAGE_CARDS: Record<string, ReactNode> = {
  monitoring: (
    <>
      <RiskFeedCard />
      <SafeCard />
      <GuardCard />
      <VerificationStatusCard />
      <SecurityHealthCard />
    </>
  ),
  decisions: (
    <>
      <AuditCard />
      <SimulationCard />
    </>
  ),
  policy: (
    <>
      <PolicyPanel />
      <PolicyChat />
    </>
  ),
  investigation: (
    <>
      <RiskDecisionCard />
      <BatchRiskCard />
      <SimulationIntegrityCard />
      <AuthorizationCard />
      <NonceConflictCard />
      <SecurityTimelineCard />
      <ActionAuthCard />
    </>
  ),
  demo: <SimulateAttackCard />,
}

/** The order the overview stacks its groups in: the order a transaction meets them. */
const OVERVIEW_ORDER = ["monitoring", "decisions", "policy", "investigation", "demo"]

function PageHead({ id }: { id: string }) {
  const page = PAGES.find((p) => p.id === id)
  if (!page) return null
  return (
    <header className="page-head">
      <p className={`page-eyebrow page-eyebrow-${page.tone}`}>
        <span aria-hidden="true" className={`nav-dot nav-dot-${page.tone}`} />
        {page.source}
      </p>
      <h1 className="page-title">{page.title}</h1>
      <p className="page-body">{page.blurb}</p>
    </header>
  )
}

/** One labelled group on the overview page. */
function StackSection({ id }: { id: string }) {
  const page = PAGES.find((p) => p.id === id)
  if (!page) return null
  return (
    <section className="stack-section">
      <div className="stack-head">
        <h2 className="stack-title">{page.title}</h2>
        <span className={`page-eyebrow page-eyebrow-${page.tone}`} style={{ margin: 0 }}>
          <span aria-hidden="true" className={`nav-dot nav-dot-${page.tone}`} />
          {page.source}
        </span>
      </div>
      <div className="grid">{PAGE_CARDS[id]}</div>
    </section>
  )
}

const PAGE_IDS = PAGES.map((p) => p.id)
const DEFAULT_PAGE = "overview"

export function App() {
  // Read from the URL, so /app/monitoring survives a refresh and each section
  // is linkable.
  const [activeId, setActiveId] = useState(() =>
    idFromLocation(DEFAULT_PAGE, PAGE_IDS),
  )
  // Open on a desktop, closed on a phone: below 900px the sidebar overlays the
  // content rather than sitting beside it, so defaulting it open would hide the
  // dashboard behind the nav on first load.
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900,
  )
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Ctrl/⌘ K anywhere. Bound on the window rather than a field so it works
  // wherever focus happens to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Back and forward move between sections rather than leaving the dashboard.
  useEffect(() => {
    const onPop = () => setActiveId(idFromLocation(DEFAULT_PAGE, PAGE_IDS))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const select = useCallback((id: string) => {
    setActiveId(id)
    window.history.pushState({ id }, "", pathForId(id, DEFAULT_PAGE))
    // A section change is a page change; land at the top of it.
    window.scrollTo({ top: 0, behavior: "instant" })
  }, [])

  return (
    <div className="shell">
      <Sidebar
        activeId={activeId}
        onSelect={select}
        collapsed={collapsed}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Show sections" : "Hide sections"}
            aria-expanded={!collapsed}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" />
              <path d="M9 4v16" />
            </svg>
          </button>

          <nav className="crumbs" aria-label="Breadcrumb">
            <a className="crumb-home" href={SITE_URL}>
              Tripwire
            </a>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">
              {PAGES.find((p) => p.id === activeId)?.title}
            </span>
          </nav>

          <div className="topbar-right">
            <ConnectWallet />
          </div>
        </header>

        <main className="content">
          <PageHead id={activeId} />

          {activeId === "overview" ? (
            OVERVIEW_ORDER.map((id) => <StackSection key={id} id={id} />)
          ) : (
            <div className="grid">{PAGE_CARDS[activeId]}</div>
          )}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={select} />
      )}

    </div>
  )
}

export default App
