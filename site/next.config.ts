import type { NextConfig } from "next";

/**
 * The site is the single front door for the whole product.
 *
 *   /            /docs   /support   ->  this Next app
 *   /app/*                          ->  the Vite dashboard (frontend/)
 *
 * The dashboard stays a separate application with its own build — this only
 * decides how its output reaches the browser, and the answer differs between
 * development and production.
 *
 * Development
 *   `DASHBOARD_ORIGIN` points at the Vite dev server (http://localhost:5173),
 *   and /app/* is proxied to it. Vite is configured with `base: "/app/"`, so
 *   the paths line up on both sides and HMR keeps working — the Vite client
 *   dials its own port directly, which is why 5173 still has to be up. It is
 *   just no longer the address anyone types.
 *
 * Production
 *   `npm run build` in frontend/ emits into site/public/app, so Next serves the
 *   dashboard as static files from its own origin — one server, one domain, no
 *   proxy process to run or keep alive. The `fallback` rewrite below is what
 *   makes refreshing /app/monitoring work: fallback rewrites are consulted only
 *   after the filesystem and public/ have both missed, so real assets
 *   (/app/assets/*.js) are served normally and only unmatched section URLs land
 *   on the dashboard's index.html for its own router to read.
 *
 * The backend services (orchestrator 3001, audit 3002, simulation 3003) and the
 * chain (8545) are deliberately NOT mapped into this URL space. They are called
 * directly by the dashboard over CORS and are not part of the public surface.
 */
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN;

const nextConfig: NextConfig = {
  async rewrites() {
    if (DASHBOARD_ORIGIN) {
      // Dev: hand /app/* to the Vite dev server. `beforeFiles` so it wins ahead
      // of anything Next might otherwise claim.
      return {
        beforeFiles: [
          { source: "/app", destination: `${DASHBOARD_ORIGIN}/app/` },
          {
            source: "/app/:path*",
            destination: `${DASHBOARD_ORIGIN}/app/:path*`,
          },
        ],
        afterFiles: [],
        fallback: [],
      };
    }

    // Production: the build already sits in public/app. Only fill in the gaps.
    return {
      beforeFiles: [{ source: "/app", destination: "/app/index.html" }],
      afterFiles: [],
      fallback: [{ source: "/app/:path*", destination: "/app/index.html" }],
    };
  },
};

export default nextConfig;
