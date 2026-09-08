/**
 * The Tripwire mark, as geometry rather than as a component.
 *
 * A wire strung taut between two posts, with the trigger node at its centre —
 * the thing that trips. Drawn from the product's own idea rather than adapted
 * from any existing logo, and legible down to favicon size because nothing in
 * it is smaller than the stroke width.
 *
 * This is path data, not JSX, on purpose. The landing site is Next and the
 * dashboard is Vite; sharing a React component between them would mean each
 * bundler compiling the other's JSX and a shared React version, which is real
 * coupling for one logo. Sharing four strings costs nothing — both apps render
 * them inside their own `<svg>`, keeping `currentColor` and their own sizing.
 */

/** The viewBox both renderings must use for the geometry to be correct. */
export const MARK_VIEWBOX = "0 0 24 24"

/** Stroked paths: the two posts, then the wire between them. */
export const MARK_STROKES = [
  "M3 5.5V18.5", // left post
  "M21 5.5V18.5", // right post
  "M3 12H21", // the wire
] as const

/** The trigger node at the centre of the wire. Filled, not stroked. */
export const MARK_NODE = { cx: 12, cy: 12, r: 2.75 } as const
