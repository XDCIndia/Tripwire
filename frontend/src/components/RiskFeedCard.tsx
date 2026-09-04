import { useQuery } from "@tanstack/react-query"

/**
 * Issue #17: the live risk feed. Lists pending/recent Safe transactions
 * with their canonical verdict - score, label, and (when the backend has
 * it) the LLM's plain-English reasons - and refreshes on a poll so new
 * verdicts appear as they land.
 *
 * Feed contract (served by `GET $VITE_RISK_FEED_URL`, an array newest-
 * first). The risk orchestrator's `GET /tx` maps onto it directly once
 * issue #45 merges; until then any mocked verdict API that returns this
 * shape works:
 *
 *   {
 *     txHash: string
 *     status?: "low_risk" | "medium_risk" | "high_risk" | "frozen" | "pending"
 *     score?: number
 *     action?: "allow" | "delay" | "block" | "freeze"
 *     reasons?: string[]   // LLM plain-English explanations
 *     at?: string          // ISO timestamp
 *   }
 *
 * Rows are color-coded at a glance (dot + accent border per state), not
 * only labeled. Inert with a setup hint when no feed URL is configured.
 */

interface RiskFeedItemDto {
  txHash: string
  status?: string
  score?: number
  action?: string
  reasons?: string[]
  at?: string
}

const configuredFeed = import.meta.env.VITE_RISK_FEED_URL as string | undefined
const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined
/** VITE_RISK_FEED_URL wins; otherwise the feed is served at GET /tx on the orchestrator. */
const feedUrl: string | undefined = configuredFeed ?? (backendUrl ? `${backendUrl}/tx` : undefined)

async function fetchFeed(): Promise<RiskFeedItemDto[]> {
  const res = await fetch(feedUrl!)
  if (!res.ok) throw new Error(`risk feed returned ${res.status}`)
  const body = (await res.json()) as unknown
  return normalizeFeed(body)
}

/**
 * The orchestrator (issue #45, now merged) serves processing states, not
 * bare feed items - map the state onto the feed DTO the list renders.
 */
function normalizeFeed(body: unknown): RiskFeedItemDto[] {
  const items = Array.isArray(body) ? body : (body as { items?: unknown[] }).items
  if (!Array.isArray(items)) return []
  return items.map((raw) => {
    const state = raw as {
      txHash?: string
      status?: string
      updatedAt?: string
      canonical?: {
        score?: number
        status?: string
        action?: string
        explanation?: string
        contributions?: Array<{ reasons?: string[] }>
      }
    }
    const reasons: string[] = []
    if (state.canonical?.explanation) reasons.push(state.canonical.explanation)
    for (const c of state.canonical?.contributions ?? []) reasons.push(...(c.reasons ?? []))
    return {
      txHash: state.txHash ?? "",
      score: state.canonical?.score,
      status: state.canonical?.status ?? "pending",
      action: state.canonical?.action as RiskFeedItemDto["action"],
      reasons: reasons.length > 0 ? reasons : undefined,
      at: state.updatedAt ?? new Date().toISOString(),
    }
  })
}

function shorten(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

/** Maps a feed status to the glanceable state class. */
function stateClass(status?: string): string {
  switch (status) {
    case "high_risk":
      return "feed-high"
    case "frozen":
      return "feed-frozen"
    case "medium_risk":
      return "feed-delay"
    case "low_risk":
      return "feed-low"
    default:
      return "feed-pending"
  }
}

function stateLabel(item: RiskFeedItemDto): string {
  if (!item.status || item.status === "pending") return "ANALYZING"
  return item.status.replace("_", " ").toUpperCase()
}

function actionLabel(item: RiskFeedItemDto): string {
  if (item.status === "frozen") return "FROZEN"
  return (item.action ?? "—").toUpperCase()
}

function FeedRow({ item }: { item: RiskFeedItemDto }) {
  const cls = stateClass(item.status)
  return (
    <li className={`feed-item ${cls}`}>
      <div className="feed-head">
        <span className="feed-dot" aria-hidden="true" />
        <span className="mono feed-hash">{shorten(item.txHash)}</span>
        <span className="feed-state">{stateLabel(item)}</span>
        <span className="feed-score">{item.score !== undefined ? `${item.score}/100` : "—"}</span>
        <span className="feed-action">{actionLabel(item)}</span>
      </div>
      {item.reasons && item.reasons.length > 0 ? (
        <ul className="feed-reasons">
          {item.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {item.at ? <div className="feed-at">{new Date(item.at).toLocaleString()}</div> : null}
    </li>
  )
}

export function RiskFeedCard() {
  const enabled = Boolean(feedUrl)
  const query = useQuery({
    queryKey: ["risk-feed"],
    queryFn: fetchFeed,
    refetchInterval: 4000, // polling: live as new verdicts land
    enabled,
  })

  const items = query.data ?? []

  return (
    <section className="card">
      <h2>Live risk feed</h2>
      {!enabled ? (
        <p className="sim-note">Set VITE_RISK_FEED_URL (or VITE_BACKEND_URL) to stream verdicts from the watcher.</p>
      ) : query.isLoading ? (
        "Loading…"
      ) : query.isError ? (
        <p className="sim-warning">⚠️ Risk feed unreachable</p>
      ) : items.length === 0 ? (
        <p className="sim-note">No transactions yet.</p>
      ) : (
        <ul className="feed-list">
          {items.map((item) => (
            <FeedRow key={`${item.txHash}:${item.at ?? ""}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}
