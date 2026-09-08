/**
 * Where the landing page points people.
 *
 * The dashboard is a separate application (frontend/), but it is served under
 * this same origin at /app — in development by a rewrite to the Vite dev
 * server, in production as static files in public/app. See next.config.ts.
 *
 * So this is a path, not a host: the port the dashboard actually runs on is an
 * implementation detail nobody should see in a link. Override with
 * NEXT_PUBLIC_DASHBOARD_URL only to point at a genuinely separate deployment.
 */
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "/app";

export const REPO_URL = "https://github.com/Ike-weber/Tripwire";
