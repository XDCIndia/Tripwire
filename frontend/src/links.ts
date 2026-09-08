/* ---------------------------------------------------------------------------
   Where the dashboard points back to.

   The landing site is the product's front door and the dashboard is served
   under /app on that same origin (see site/next.config.ts), so home is a path,
   not a host — mirroring site/src/lib/links.ts, which names the dashboard the
   same way. Neither app should ever hard-code the other's port.

   The exception is running `vite dev` on its own, without the site in front of
   it: nothing answers at / on 5173. Set VITE_SITE_URL=http://localhost:3000 for
   that, or point it at a genuinely separate deployment.
   --------------------------------------------------------------------------- */

export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) ?? "/"
