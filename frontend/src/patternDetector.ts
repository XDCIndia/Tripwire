/**
 * Issue #99: Cross-Transaction Attack Pattern Detection
 *
 * Detects suspicious patterns across multiple related transactions by
 * correlating operations over time. Groups transactions by wallet/asset/
 * counterparty and identifies sequences like approval→transfer,
 * repeated allowance increases, and interactions with new contracts.
 */

// ─── Transaction types ───────────────────────────────────────────────

export type TxOperation =
  | "approve"
  | "transfer"
  | "transferFrom"
  | "setApprovalForAll"
  | "contractInteraction"
  | "unknown"

export interface TxRecord {
  txHash: string
  timestamp: number
  from: string
  to: string
  operation: TxOperation
  asset?: string
  amount?: bigint
  risk?: "low" | "medium" | "high"
}

// ─── Pattern types ───────────────────────────────────────────────────

export type PatternSeverity = "critical" | "high" | "medium" | "low"

export interface DetectedPattern {
  id: string
  severity: PatternSeverity
  name: string
  description: string
  transactions: TxRecord[]
  signals: string[]
  /** Plain-English explanation of why this is suspicious */
  explanation: string
}

// ─── Pattern matching ────────────────────────────────────────────────

/**
 * Given a set of transactions, group them into related sequences
 * and detect suspicious patterns.
 */
export function detectPatterns(transactions: TxRecord[]): DetectedPattern[] {
  if (transactions.length < 2) return []

  const sequences = groupRelatedTransactions(transactions)
  const patterns: DetectedPattern[] = []

  for (const seq of sequences) {
    if (seq.length < 2) continue
    // Sort by timestamp
    seq.sort((a, b) => a.timestamp - b.timestamp)

    // Check each pattern type
    const detected = [
      ...checkApprovalThenTransfer(seq),
      ...checkRepeatedAllowanceIncreases(seq),
      ...checkNewContractInteraction(seq),
      ...checkSmallThenLargeTransfer(seq),
      ...checkRepeatedSuspiciousCounterparty(seq),
      ...checkPermissionThenAssetMovement(seq),
    ]

    patterns.push(...detected)
  }

  // Deduplicate by id
  const seen = new Set<string>()
  return patterns.filter((p) => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })
}

/**
 * Group transactions by shared attributes (wallet, asset, counterparty).
 * Returns arrays of related transaction sequences.
 */
function groupRelatedTransactions(txs: TxRecord[]): TxRecord[][] {
  const groups = new Map<string, TxRecord[]>()

  for (const tx of txs) {
    // Group by wallet
    const walletKey = `wallet:${tx.from}`
    addOrCreate(groups, walletKey, tx)

    // Group by asset
    if (tx.asset) {
      const assetKey = `asset:${tx.asset}`
      addOrCreate(groups, assetKey, tx)
    }

    // Group by counterparty
    const counterpartyKey = `counterparty:${tx.from}:${tx.to}`
    addOrCreate(groups, counterpartyKey, tx)
    const reverseKey = `counterparty:${tx.to}:${tx.from}`
    addOrCreate(groups, reverseKey, tx)
  }

  // Merge overlapping groups
  const allGroups = Array.from(groups.values())
  return mergeOverlappingGroups(allGroups)
}

function addOrCreate(map: Map<string, TxRecord[]>, key: string, tx: TxRecord) {
  const existing = map.get(key)
  if (existing) {
    existing.push(tx)
  } else {
    map.set(key, [tx])
  }
}

function mergeOverlappingGroups(groups: TxRecord[][]): TxRecord[][] {
  const result: TxRecord[][] = []
  const used = new Set<number>()

  for (let i = 0; i < groups.length; i++) {
    if (used.has(i)) continue
    let merged = new Set(groups[i].map((tx) => tx.txHash))
    let mergedTxs = [...groups[i]]
    used.add(i)

    for (let j = i + 1; j < groups.length; j++) {
      if (used.has(j)) continue
      const overlap = groups[j].some((tx) => merged.has(tx.txHash))
      if (overlap) {
        for (const tx of groups[j]) merged.add(tx.txHash)
        mergedTxs = mergedTxs.concat(groups[j])
        used.add(j)
      }
    }

    // Deduplicate by txHash
    const deduped = new Map<string, TxRecord>()
    for (const tx of mergedTxs) deduped.set(tx.txHash, tx)
    result.push(Array.from(deduped.values()))
  }

  return result
}

// ─── Pattern checkers ────────────────────────────────────────────────

function checkApprovalThenTransfer(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  const approvals = txs.filter((tx) => tx.operation === "approve" || tx.operation === "setApprovalForAll")
  const transfers = txs.filter((tx) => tx.operation === "transfer" || tx.operation === "transferFrom")

  for (const approval of approvals) {
    for (const transfer of transfers) {
      if (transfer.timestamp > approval.timestamp && transfer.asset === approval.asset) {
        const involved = [approval, transfer]
        patterns.push({
          id: `approval-then-transfer:${approval.txHash}:${transfer.txHash}`,
          severity: "high",
          name: "Approval followed by transfer",
          description: `Token approval at ${shortHash(approval.txHash)} followed by asset transfer at ${shortHash(transfer.txHash)}.`,
          transactions: involved,
          signals: ["approval-then-transfer"],
          explanation: `A token approval was granted and then assets were transferred. This pattern is commonly used in token draining attacks where the attacker first gains spending permission, then moves assets.`,
        })
      }
    }
  }

  return patterns
}

function checkRepeatedAllowanceIncreases(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  const approvals = txs
    .filter((tx) => tx.operation === "approve")
    .sort((a, b) => a.timestamp - b.timestamp)

  if (approvals.length < 2) return patterns

  // Check for same asset + same spender with increasing amounts
  for (let i = 0; i < approvals.length - 1; i++) {
    const a = approvals[i]
    const b = approvals[i + 1]
    if (a.asset === b.asset && a.to === b.to && a.amount !== undefined && b.amount !== undefined) {
      if (b.amount > a.amount) {
        patterns.push({
          id: `repeated-increase:${a.txHash}:${b.txHash}`,
          severity: "medium",
          name: "Repeated allowance increase",
          description: `Allowance for ${a.asset} increased from ${a.amount} to ${b.amount} for the same spender.`,
          transactions: [a, b],
          signals: ["repeated-allowance-increase"],
          explanation: `The same token allowance was increased multiple times for the same spender. This can indicate an attacker gradually expanding their spending permission.`,
        })
      }
    }
  }

  return patterns
}

function checkNewContractInteraction(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  const contractTxs = txs.filter((tx) => tx.operation === "contractInteraction")

  if (contractTxs.length < 1) return patterns

  // Any contract interaction after an approval is suspicious
  const approvals = txs.filter((tx) => tx.operation === "approve")
  for (const approval of approvals) {
    for (const interaction of contractTxs) {
      if (interaction.timestamp > approval.timestamp) {
        patterns.push({
          id: `new-contract-after-approve:${approval.txHash}:${interaction.txHash}`,
          severity: "high",
          name: "Contract interaction after approval",
          description: `Approval at ${shortHash(approval.txHash)} followed by contract interaction at ${shortHash(interaction.txHash)}.`,
          transactions: [approval, interaction],
          signals: ["approval-then-contract-interaction"],
          explanation: `A token approval was granted followed by interaction with a contract. This may indicate the approved contract is being used to move assets.`,
        })
      }
    }
  }

  return patterns
}

function checkSmallThenLargeTransfer(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  const transfers = txs
    .filter((tx) => tx.operation === "transfer" && tx.amount !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)

  if (transfers.length < 2) return patterns

  // Check for small transfers followed by a large one to the same recipient
  for (let i = 0; i < transfers.length - 1; i++) {
    const small = transfers[i]
    const large = transfers[i + 1]
    if (
      small.to === large.to &&
      small.asset === large.asset &&
      small.amount !== undefined &&
      large.amount !== undefined &&
      large.amount > small.amount * 5n
    ) {
      patterns.push({
        id: `small-then-large:${small.txHash}:${large.txHash}`,
        severity: "medium",
        name: "Small transfers before large transfer",
        description: `Multiple small transfers to the same recipient followed by a large transfer.`,
        transactions: [small, large],
        signals: ["small-then-large-transfer"],
        explanation: `Several small test transfers were sent to the same address before a much larger transfer. This is a common pattern where attackers test the waters before draining assets.`,
      })
    }
  }

  return patterns
}

function checkRepeatedSuspiciousCounterparty(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []

  // Group by recipient
  const byTo = new Map<string, TxRecord[]>()
  for (const tx of txs) {
    if (tx.risk === "high" || tx.risk === "medium") {
      addOrCreate(byTo, tx.to, tx)
    }
  }

  for (const [to, toTxs] of byTo) {
    if (toTxs.length >= 2) {
      patterns.push({
        id: `repeated-counterparty:${to}`,
        severity: "medium",
        name: "Repeated interactions with same counterparty",
        description: `${toTxs.length} transactions to the same address ${shortHash(to)}.`,
        transactions: toTxs,
        signals: ["repeated-suspicious-counterparty"],
        explanation: `Multiple risk-flagged transactions were sent to the same address. This indicates sustained interaction with a potentially suspicious counterparty.`,
      })
    }
  }

  return patterns
}

function checkPermissionThenAssetMovement(txs: TxRecord[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = []
  const permissions = txs.filter((tx) => tx.operation === "approve" || tx.operation === "setApprovalForAll")
  const movements = txs.filter((tx) => tx.operation === "transfer" || tx.operation === "transferFrom" || tx.operation === "contractInteraction")

  for (const perm of permissions) {
    for (const move of movements) {
      if (move.timestamp > perm.timestamp) {
        patterns.push({
          id: `permission-then-movement:${perm.txHash}:${move.txHash}`,
          severity: "high",
          name: "Permission creation followed by asset movement",
          description: `Permission granted at ${shortHash(perm.txHash)} followed by asset movement at ${shortHash(move.txHash)}.`,
          transactions: [perm, move],
          signals: ["permission-then-asset-movement"],
          explanation: `A new permission (approval or operator) was created followed by asset movement. This is the core pattern of a token draining attack.`,
        })
      }
    }
  }

  return patterns
}

// ─── Helpers ─────────────────────────────────────────────────────────

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

/**
 * Calculate overall pattern severity from a list of detected patterns.
 */
export function calculateOverallSeverity(patterns: DetectedPattern[]): PatternSeverity {
  if (patterns.some((p) => p.severity === "critical")) return "critical"
  if (patterns.some((p) => p.severity === "high")) return "high"
  if (patterns.some((p) => p.severity === "medium")) return "medium"
  return "low"
}
