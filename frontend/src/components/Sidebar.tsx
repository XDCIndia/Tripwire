import {
  MARK_NODE,
  MARK_STROKES,
  MARK_VIEWBOX,
} from "../../../shared/tripwireMark.js"

import { activeChain } from "../config.js"
import { SITE_URL } from "../links.js"
import { NAV_GROUPS } from "../nav.js"

/**
 * The Tripwire mark. The geometry is shared with the landing site — see
 * shared/tripwireMark.ts — so the two cannot drift apart.
 */
function Mark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox={MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="sidebar-mark"
    >
      {MARK_STROKES.map((d) => (
        <path key={d} d={d} />
      ))}
      <circle {...MARK_NODE} fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * The nav. Grouped by whether a page's numbers are real, because that is the
 * question a reader has before they have any others.
 */
export function Sidebar({
  activeId,
  onSelect,
  collapsed,
  onOpenPalette,
}: {
  activeId: string
  onSelect: (id: string) => void
  collapsed: boolean
  onOpenPalette: () => void
}) {
  return (
    <aside
      className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}
      aria-label="Sections"
      // Hidden from the tab order when collapsed, so focus does not disappear
      // into a zero-width panel.
      inert={collapsed || undefined}
    >
      <div className="sidebar-brand">
        {/* The wordmark is the way back to the site, the way a product's logo
            always is. The chain badge stays outside the link — it labels the
            deployment, it is not part of the brand. */}
        <a className="sidebar-home" href={SITE_URL}>
          <Mark />
          <span className="sidebar-brand-name">Tripwire</span>
        </a>
        <span className="sidebar-chain">{activeChain.name}</span>
      </div>

      <nav className="sidebar-scroll">
        {NAV_GROUPS.map((group, i) => (
          <div className="nav-group" key={group.heading ?? `group-${i}`}>
            {group.heading && (
              <span className="nav-heading">
                {group.tone && (
                  <span
                    aria-hidden="true"
                    className={`nav-dot nav-dot-${group.tone}`}
                  />
                )}
                {group.heading}
              </span>
            )}
            {group.pages.map((page) => {
              const Icon = page.icon
              const active = page.id === activeId
              return (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => onSelect(page.id)}
                  aria-current={active ? "page" : undefined}
                  className={`nav-item${active ? " nav-item-active" : ""}`}
                >
                  <Icon className="nav-icon" />
                  <span className="nav-label">{page.title}</span>
                  <span className="nav-count">{page.cards}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="sidebar-search" onClick={onOpenPalette}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21" strokeLinecap="round" />
          </svg>
          Jump to
          <kbd className="kbd">Ctrl K</kbd>
        </button>
      </div>
    </aside>
  )
}
