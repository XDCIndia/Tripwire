/* ---------------------------------------------------------------------------
   Section routing.

   The dashboard is served under /app/ behind the site's rewrite, and sections
   used to be plain component state — which meant no section had a URL, the back
   button did nothing, and there was nothing to refresh. This gives each section
   an address without adding a router: the History API is enough for a flat list
   of six pages, and pulling in react-router for that would be more moving parts
   than the problem has.

   /app/            -> overview
   /app/monitoring  -> monitoring
   /app/<unknown>   -> overview

   BASE has to match `base` in vite.config.ts. If one moves, the other must.
   --------------------------------------------------------------------------- */

export const BASE = "/app"

/** The section named by the current URL, or the fallback when it names none. */
export function idFromLocation(fallback: string, known: readonly string[]): string {
  if (typeof window === "undefined") return fallback
  const path = window.location.pathname
  // Tolerate being served from the root too, so `vite dev` without the site in
  // front of it still works.
  const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path
  const id = rest.replace(/^\/+|\/+$/g, "")
  return id && known.includes(id) ? id : fallback
}

/**
 * The URL a section should live at.
 *
 * The default section is `/app`, not `/app/`: Next normalises the trailing
 * slash away with a 308, so pushing the slashed form would make a refresh of
 * the overview take a needless redirect.
 */
export function pathForId(id: string, fallback: string): string {
  return id === fallback ? BASE : `${BASE}/${id}`
}
