/**
 * Issue #43: Continuous Wallet Behavior Baseline & Anomaly Detection
 *
 * Maintains a historical behavioral profile for each protected wallet
 * and detects significant deviations that indicate suspicious activity.
 *
 * The output is a machine-readable anomaly signal the risk engine can
 * score alongside other signals — anomalies raise risk but never block
 * on their own (enforcement stays with the policy layer).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single observed transaction for baseline computation. */
export interface ObservedTransaction {
  txHash: string
  to: string
  value: bigint
  data: string
  timestamp: number
}

/** Rolling behavioral profile for one wallet. */
export interface WalletProfile {
  walletAddress: string
  /** Total transactions observed. */
  transactionCount: number
  /** Rolling window of observed transactions (most recent first). */
  recentTransactions: ObservedTransaction[]
  /** Statistical baseline derived from observations. */
  baseline: BehaviorBaseline
  /** Set of all counterparties this wallet has interacted with. */
  knownCounterparties: Set<string>
  /** Timestamp of first observed activity. */
  firstSeenAt: number
  /** Timestamp of most recent observation. */
  lastSeenAt: number
}

/** Statistical baseline for anomaly comparison. */
export interface BehaviorBaseline {
  /** Mean transaction value in wei. */
  averageValue: bigint
  /** Standard deviation of transaction values (wei). */
  valueStdDev: bigint
  /** p95 transaction value (wei). */
  p95Value: bigint
  /** Median transaction value (wei). */
  medianValue: bigint
  /** Average transactions per day. */
  frequencyPerDay: number
  /** Set of known recipient patterns (lowercase addresses). */
  knownRecipients: Set<string>
  /** Number of approval/setApprovalForAll transactions observed. */
  approvalCount: number
  /** Ratio of approval transactions to total. */
  approvalRatio: number
}

/** Output of the anomaly detection engine. */
export interface AnomalyResult {
  /** Whether any anomaly was detected. */
  isAnomalous: boolean
  /** Machine-readable anomaly score (0-100, higher = more anomalous). */
  anomalyScore: number
  /** List of specific anomalies detected. */
  signals: AnomalySignal[]
  /** Human-readable explanation of what triggered the anomaly. */
  explanation: string
}

export interface AnomalySignal {
  signal: string
  severity: "low" | "medium" | "high"
  detail: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BehaviorConfig {
  /** Max transactions to keep in the rolling window. */
  maxHistory?: number
  /** Minimum transactions before baseline is considered reliable. */
  minTransactionsForBaseline?: number
  /** How many standard deviations above mean triggers value anomaly. */
  valueStdDevThreshold?: number
  /** How far above p95 triggers value anomaly. */
  valueP95Multiplier?: number
}

const DEFAULT_CONFIG: Required<BehaviorConfig> = {
  maxHistory: 200,
  minTransactionsForBaseline: 5,
  valueStdDevThreshold: 3,
  valueP95Multiplier: 2,
}

// ---------------------------------------------------------------------------
// WalletBehaviorEngine
// ---------------------------------------------------------------------------

export class WalletBehaviorEngine {
  private readonly profiles = new Map<string, WalletProfile>()
  private readonly config: Required<BehaviorConfig>

  constructor(config: BehaviorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a new transaction observation for a wallet.
   * Updates the rolling profile and recomputes the baseline.
   */
  observe(walletAddress: string, tx: ObservedTransaction): WalletProfile {
    let profile = this.profiles.get(walletAddress)
    if (!profile) {
      profile = {
        walletAddress,
        transactionCount: 0,
        recentTransactions: [],
        baseline: this.emptyBaseline(),
        knownCounterparties: new Set(),
        firstSeenAt: tx.timestamp,
        lastSeenAt: tx.timestamp,
      }
      this.profiles.set(walletAddress, profile)
    }

    // Add to rolling window.
    profile.recentTransactions.unshift(tx)
    if (profile.recentTransactions.length > this.config.maxHistory) {
      profile.recentTransactions.pop()
    }

    profile.transactionCount++
    profile.knownCounterparties.add(tx.to.toLowerCase())
    profile.lastSeenAt = Math.max(profile.lastSeenAt, tx.timestamp)
    profile.firstSeenAt = Math.min(profile.firstSeenAt, tx.timestamp)

    // Recompute baseline.
    profile.baseline = this.computeBaseline(profile.recentTransactions)

    return profile
  }

  /**
   * Detect anomalies in a new transaction against the wallet's baseline.
   * Returns a machine-readable AnomalyResult the risk engine can score.
   */
  detect(walletAddress: string, tx: ObservedTransaction): AnomalyResult {
    const profile = this.profiles.get(walletAddress)

    // Not enough data — no anomalies to detect.
    if (!profile || profile.transactionCount < this.config.minTransactionsForBaseline) {
      return { isAnomalous: false, anomalyScore: 0, signals: [], explanation: "Insufficient history for behavioral analysis" }
    }

    const baseline = profile.baseline
    const signals: AnomalySignal[] = []

    // 1. Value anomaly: significantly above p95 or mean + N*stddev.
    if (tx.value > baseline.p95Value * BigInt(this.config.valueP95Multiplier) && baseline.p95Value > 0n) {
      signals.push({
        signal: "ABNORMAL_VALUE",
        severity: "high",
        detail: `Transaction value ${tx.value} exceeds ${this.config.valueP95Multiplier}x p95 (${baseline.p95Value})`,
      })
    } else if (baseline.valueStdDev > 0n && tx.value > baseline.averageValue + baseline.valueStdDev * BigInt(this.config.valueStdDevThreshold)) {
      signals.push({
        signal: "ABNORMAL_VALUE",
        severity: "medium",
        detail: `Transaction value ${tx.value} exceeds mean + ${this.config.valueStdDevThreshold} stddev`,
      })
    }

    // 2. First-seen counterparty.
    if (!profile.knownCounterparties.has(tx.to.toLowerCase())) {
      signals.push({
        signal: "FIRST_SEEN_COUNTERPARTY",
        severity: "medium",
        detail: `Recipient ${tx.to} has not been seen before for this wallet`,
      })
    }

    // 3. Approval behavior: setApprovalForAll or approve in the calldata.
    const selector = tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : ""
    const isApproval = selector === "0xa22cb465" || selector === "0x095ea7b3"
    if (isApproval) {
      if (baseline.approvalRatio > 0.3) {
        signals.push({
          signal: "APPROVAL_PATTERN",
          severity: "low",
          detail: `Approval transaction matches wallet's existing approval pattern (${(baseline.approvalRatio * 100).toFixed(0)}% of historical txs)`,
        })
      } else {
        signals.push({
          signal: "UNUSUAL_APPROVAL",
          severity: "high",
          detail: `Approval transaction is unusual for this wallet (${(baseline.approvalRatio * 100).toFixed(0)}% historical approval rate)`,
        })
      }
    }

    // 4. Frequency spike: transactions arriving faster than baseline.
    if (profile.recentTransactions.length >= 2) {
      const recentInterval = profile.recentTransactions[0].timestamp - profile.recentTransactions[1].timestamp
      const avgInterval = profile.baseline.frequencyPerDay > 0 ? 86400 / profile.baseline.frequencyPerDay : Infinity
      if (recentInterval < avgInterval * 0.1 && avgInterval < Infinity && avgInterval > 0) {
        signals.push({
          signal: "FREQUENCY_SPIKE",
          severity: "medium",
          detail: `Transaction arrived ${recentInterval}s after previous (baseline avg: ${avgInterval.toFixed(0)}s)`,
        })
      }
    }

    // Compute aggregate anomaly score.
    let anomalyScore = 0
    for (const s of signals) {
      if (s.severity === "high") anomalyScore += 35
      else if (s.severity === "medium") anomalyScore += 20
      else anomalyScore += 10
    }
    anomalyScore = Math.min(anomalyScore, 100)

    const explanation = signals.length > 0
      ? signals.map((s) => s.detail).join("; ")
      : "Transaction matches established behavioral patterns"

    return {
      isAnomalous: signals.length > 0,
      anomalyScore,
      signals,
      explanation,
    }
  }

  /** Get the behavioral profile for a wallet (or null if not tracked). */
  getProfile(walletAddress: string): WalletProfile | null {
    return this.profiles.get(walletAddress) ?? null
  }

  /** Get the p95 value for a wallet (used by the existing risk engine input). */
  getP95Value(walletAddress: string): bigint {
    const profile = this.profiles.get(walletAddress)
    if (!profile) return 0n
    return profile.baseline.p95Value
  }

  /** Check if a counterparty is first-seen for this wallet. */
  isFirstSeenCounterparty(walletAddress: string, counterparty: string): boolean {
    const profile = this.profiles.get(walletAddress)
    if (!profile) return true
    return !profile.knownCounterparties.has(counterparty.toLowerCase())
  }

  // ---------------------------------------------------------------------------
  // Internal: baseline computation
  // ---------------------------------------------------------------------------

  private computeBaseline(transactions: ObservedTransaction[]): BehaviorBaseline {
    if (transactions.length === 0) return this.emptyBaseline()

    const values = transactions.map((t) => t.value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const averageValue = values.reduce((sum, v) => sum + v, 0n) / BigInt(values.length)
    const medianValue = values[Math.floor(values.length / 2)]

    // Standard deviation.
    const variance = values.reduce((sum, v) => {
      const diff = v > averageValue ? v - averageValue : averageValue - v
      return sum + diff * diff
    }, 0n) / BigInt(values.length)
    const valueStdDev = isqrt(variance)

    // p95.
    const p95Index = Math.floor(values.length * 0.95)
    const p95Value = values[Math.min(p95Index, values.length - 1)]

    // Frequency: transactions per day.
    const timeSpan = transactions[0].timestamp - transactions[transactions.length - 1].timestamp
    const frequencyPerDay = timeSpan > 0 ? (transactions.length / timeSpan) * 86400 : 0

    // Known recipients.
    const knownRecipients = new Set(transactions.map((t) => t.to.toLowerCase()))

    // Approval behavior.
    const approvalCount = transactions.filter((t) => {
      const sel = t.data.length >= 10 ? t.data.slice(0, 10).toLowerCase() : ""
      return sel === "0xa22cb465" || sel === "0x095ea7b3"
    }).length
    const approvalRatio = transactions.length > 0 ? approvalCount / transactions.length : 0

    return { averageValue, valueStdDev, p95Value, medianValue, frequencyPerDay, knownRecipients, approvalCount, approvalRatio }
  }

  private emptyBaseline(): BehaviorBaseline {
    return {
      averageValue: 0n,
      valueStdDev: 0n,
      p95Value: 0n,
      medianValue: 0n,
      frequencyPerDay: 0,
      knownRecipients: new Set(),
      approvalCount: 0,
      approvalRatio: 0,
    }
  }
}

/** Integer square root for bigint variance → stddev. */
function isqrt(n: bigint): bigint {
  if (n < 0n) return 0n
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}
