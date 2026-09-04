import type { PendingTx, RawPendingTx, SafeTxServiceClient } from "./types.js"

function normalize(raw: RawPendingTx): PendingTx {
  return {
    safeTxHash: raw.safeTxHash,
    to: raw.to,
    value: raw.value,
    data: raw.data ?? "0x",
    // The Transaction Service only started populating `proposer` directly
    // on newer versions; fall back to whoever signed first for older ones.
    proposer: raw.proposer ?? raw.confirmations?.[0]?.owner ?? "",
    nonce: raw.nonce,
  }
}

export interface WatcherOptions {
  /**
   * Consecutive poll failures after which the breaker opens and `start`
   * stops hitting the service until the cooldown elapses. Stops a dead
   * Transaction Service from being hammered every interval. Default 5.
   */
  maxConsecutiveFailures?: number
  /** Milliseconds the breaker stays open before one probe poll is allowed. Default 30_000. */
  breakerCooldownMs?: number
  /** Injectable clock for tests. */
  now?: () => number
  onBreakerChange?: (open: boolean) => void
}

export type BreakerState = "closed" | "open"

/**
 * Watches a single Safe's pending (proposed, not-yet-executed) transaction
 * queue and calls `onNewTx` exactly once per transaction, the first time it's
 * seen — this is the "Sense" step: it's the window where a transaction has
 * been proposed but not yet signed enough to execute, which is exactly when
 * the risk engine needs to score it and write a verdict.
 *
 * Resilience: continuous polling (`start`) backs off via a circuit breaker.
 * While the breaker is open the service is not called at all; after the
 * cooldown one probe poll is allowed, and success closes the breaker again.
 * A watcher that cannot reach the service must be visibly down (breaker's
 * onBreakerChange hook, logs) rather than silently retrying forever - and it
 * must recover by itself when the service comes back, with no manual
 * intervention.
 */
export class PendingTxWatcher {
  private readonly seen = new Set<string>()
  private consecutiveFailures = 0
  private breakerOpenedAt: number | null = null
  private breakerNotified = false

  private readonly maxConsecutiveFailures: number
  private readonly breakerCooldownMs: number
  private readonly now: () => number
  private readonly onBreakerChange: ((open: boolean) => void) | undefined

  constructor(
    private readonly client: SafeTxServiceClient,
    private readonly safeAddress: string,
    private readonly onNewTx: (tx: PendingTx) => void,
    options: WatcherOptions = {},
  ) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5
    this.breakerCooldownMs = options.breakerCooldownMs ?? 30_000
    this.now = options.now ?? (() => Date.now())
    this.onBreakerChange = options.onBreakerChange
  }

  /** Current breaker state - exposed for health checks and tests. */
  get breakerState(): BreakerState {
    return this.breakerOpenedAt === null ? "closed" : "open"
  }

  /** Runs one poll cycle, returning only the transactions that were new this cycle. */
  async pollOnce(): Promise<PendingTx[]> {
    try {
      const { results } = await this.client.getPendingTransactions(this.safeAddress)
      this.consecutiveFailures = 0
      if (this.breakerOpenedAt !== null) {
        this.breakerOpenedAt = null
        this.notifyBreaker(false)
        console.log("[watcher] poll succeeded again - circuit breaker closed")
      }

      const fresh: PendingTx[] = []
      for (const raw of results) {
        if (this.seen.has(raw.safeTxHash)) continue
        this.seen.add(raw.safeTxHash)

        const tx = normalize(raw)
        fresh.push(tx)
        this.onNewTx(tx)
      }
      return fresh
    } catch (err) {
      this.consecutiveFailures += 1
      if (this.breakerOpenedAt !== null) {
        // A probe poll failed - the breaker was already open, so extend the
        // cooldown from now rather than probing again on the next tick.
        this.breakerOpenedAt = this.now()
      } else if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.breakerOpenedAt = this.now()
        this.notifyBreaker(true)
        console.error(
          `[watcher] ${this.consecutiveFailures} consecutive poll failures - circuit breaker open, ` +
            `pausing polls for ${this.breakerCooldownMs}ms`,
        )
      }
      throw err
    }
  }

  private notifyBreaker(open: boolean): void {
    if (this.breakerNotified === open) return
    this.breakerNotified = open
    this.onBreakerChange?.(open)
  }

  /**
   * Starts continuous polling. Returns the interval handle so callers can
   * `clearInterval` it. While the circuit breaker is open, the service is
   * skipped entirely; when the cooldown elapses, one probe poll is allowed -
   * success closes the breaker, failure reopens it for another cooldown.
   */
  start(intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error("[watcher] poll failed:", err)
      })
    }, intervalMs)
  }

  private async tick(): Promise<void> {
    if (this.breakerOpenedAt !== null) {
      const elapsed = this.now() - this.breakerOpenedAt
      if (elapsed < this.breakerCooldownMs) return

      // Half-open: allow exactly one probe poll. On success pollOnce closes
      // the breaker; on failure it reopens with a fresh timestamp.
      await this.pollOnce()
      return
    }

    await this.pollOnce()
  }
}
