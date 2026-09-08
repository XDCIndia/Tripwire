import { useMemo, useState } from "react"

import { PAGES } from "../nav.js"

/**
 * Jump-to-page on Ctrl/⌘ K.
 *
 * Deliberately only pages: it is a navigator, not a search. A box that looks
 * like it searches transactions but only matches six section names would be
 * worse than no box at all.
 *
 * Mounted only while open (App does the conditional), so there is no state to
 * reset and no effect to reset it in — a fresh open starts empty because it is
 * a fresh component.
 */
export function CommandPalette({
  onClose,
  onSelect,
}: {
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const [rawCursor, setCursor] = useState(0)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return PAGES
    return PAGES.filter(
      (p) =>
        p.title.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q),
    )
  }, [query])

  // Derived, not stored: typing shrinks the list, and a cursor past its end
  // should simply read as the first row rather than needing an effect to
  // chase it back into range.
  const cursor = rawCursor >= results.length ? 0 : rawCursor

  const choose = (id: string) => {
    onSelect(id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      setCursor((c) => (c + 1) % Math.max(results.length, 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setCursor((c) => (c - 1 + results.length) % Math.max(results.length, 1))
    } else if (e.key === "Enter" && results[cursor]) {
      e.preventDefault()
      choose(results[cursor].id)
    }
  }

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a section"
        onKeyDown={onKeyDown}
      >
        <div className="palette-field">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            style={{ color: "rgba(255,255,255,0.4)" }}
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a section…"
            aria-label="Jump to a section"
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette-results">
          {results.length === 0 ? (
            <p className="palette-empty">No section matches “{query}”.</p>
          ) : (
            results.map((page, i) => {
              const Icon = page.icon
              return (
                <button
                  key={page.id}
                  type="button"
                  className={`palette-item${i === cursor ? " palette-item-active" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(page.id)}
                >
                  <Icon />
                  {page.title}
                  <span className="palette-item-group">{page.tone}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
