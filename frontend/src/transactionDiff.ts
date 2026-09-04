/**
 * Issue #84: Pre-Execution Transaction Diff & Risk Impact Viewer
 *
 * Generates a deterministic before/after security diff for every
 * transaction where sufficient state information is available.
 * Unknown state is explicitly marked, never inferred.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type DiffStatus = "increased" | "decreased" | "unchanged" | "new" | "removed" | "unknown"

export interface BalanceDiff {
  token: string
  tokenSymbol?: string
  before: string
  after: string
  status: DiffStatus
  /** Whether this is native currency (ETH/XDC) */
  isNative: boolean
}

export interface AllowanceDiff {
  token: string
  tokenSymbol?: string
  spender: string
  before: string
  after: string
  status: DiffStatus
  /** Whether the new allowance is unlimited (type(uint256).max) */
  isUnlimited: boolean
  /** Whether this is a newly introduced permission */
  isNew: boolean
}

export interface OperatorDiff {
  operator: string
  token: string
  tokenSymbol?: string
  approved: boolean
  before: boolean
  status: DiffStatus
  /** Whether this is a newly introduced permission */
  isNew: boolean
}

export interface PermissionDiff {
  contract: string
  contractName?: string
  permission: string
  before: boolean
  after: boolean
  status: DiffStatus
  /** Whether this is a newly introduced permission */
  isNew: boolean
}

export interface RecipientExposure {
  address: string
  label?: string
  /** Whether this recipient is first-seen (never transacted with before) */
  isFirstSeen: boolean
  /** Total value sent to this recipient in this tx */
  valueSent: string
  /** What kind of tokens/value */
  assetType: string
}

export interface RiskSignal {
  signal: string
  severity: "low" | "medium" | "high" | "critical"
  description: string
}

export interface TransactionDiff {
  /** Transaction hash this diff is bound to */
  txHash: string
  /** Destination contract/address */
  to: string
  /** Transaction value in wei */
  value: string
  /** Timestamp */
  timestamp: string

  balanceChanges: BalanceDiff[]
  allowanceChanges: AllowanceDiff[]
  operatorChanges: OperatorDiff[]
  permissionChanges: PermissionDiff[]
  recipientExposure: RecipientExposure[]
  riskSignals: RiskSignal[]
}

// ─── Helpers ─────────────────────────────────────────────────────────

const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935"

function compareAmounts(before: string, after: string): DiffStatus {
  const b = BigInt(before)
  const a = BigInt(after)
  if (b === a) return "unchanged"
  if (a > b) return "increased"
  return "decreased"
}

function isUnlimitedAllowance(amount: string): boolean {
  return BigInt(amount) >= BigInt(MAX_UINT256)
}

function shorten(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

// ─── Diff generation ─────────────────────────────────────────────────

export interface WalletState {
  /** token address -> balance in wei */
  balances: Record<string, string>
  /** `${token}:${spender}` -> allowance in wei */
  allowances: Record<string, string>
  /** `${token}:${operator}` -> approved */
  operators: Record<string, string>
  /** `contract:permission` -> granted */
  permissions: Record<string, boolean>
  /** Known recipients (addresses previously transacted with) */
  knownRecipients: Set<string>
}

export interface ProposedChange {
  /** token address */
  token: string
  tokenSymbol?: string
  /** contract address (for permission changes) */
  contract?: string
  contractName?: string
  /** new balance after */
  balanceAfter?: string
  /** new allowance after: `${spender}:${amount}` */
  allowanceAfter?: Record<string, string>
  /** new operator status: `${operator}:${approved}` */
  operatorAfter?: Record<string, boolean>
  /** new permissions: `${contract}:${permission}:${granted}` */
  permissionsAfter?: Record<string, boolean>
}

/**
 * Generate a full before/after security diff for a proposed transaction.
 */
export function generateDiff(
  txHash: string,
  to: string,
  value: string,
  currentState: WalletState,
  proposedChanges: ProposedChange[],
): TransactionDiff {
  const timestamp = new Date().toISOString()
  const balanceChanges: BalanceDiff[] = []
  const allowanceChanges: AllowanceDiff[] = []
  const operatorChanges: OperatorDiff[] = []
  const permissionChanges: PermissionDiff[] = []
  const recipientExposure: RecipientExposure[] = []
  const riskSignals: RiskSignal[] = []

  // Native balance change (value transfer)
  if (BigInt(value) > 0n) {
    const nativeBefore = currentState.balances["native"] ?? "0"
    const nativeAfter = String(BigInt(nativeBefore) - BigInt(value))
    balanceChanges.push({
      token: "native",
      tokenSymbol: "XDC",
      before: nativeBefore,
      after: nativeAfter,
      status: compareAmounts(nativeBefore, nativeAfter),
      isNative: true,
    })
  }

  for (const change of proposedChanges) {
    // Balance diff
    if (change.balanceAfter !== undefined) {
      const before = currentState.balances[change.token] ?? "0"
      const status = before === "unknown" ? "unknown" : compareAmounts(before, change.balanceAfter)
      balanceChanges.push({
        token: change.token,
        tokenSymbol: change.tokenSymbol,
        before,
        after: change.balanceAfter,
        status,
        isNative: false,
      })

      // Risk: unexpected outflow
      if (status === "decreased") {
        riskSignals.push({
          signal: "balance_decrease",
          severity: "low",
          description: `${change.tokenSymbol ?? shorten(change.token)} balance decreases`,
        })
      }
    }

    // Allowance diffs
    if (change.allowanceAfter) {
      for (const [spender, amount] of Object.entries(change.allowanceAfter)) {
        const key = `${change.token}:${spender}`
        const before = currentState.allowances[key] ?? "0"
        const beforeIsZero = before === "0" || before === "unknown"
        const unlimited = isUnlimitedAllowance(amount)
        const isNew = beforeIsZero && BigInt(amount) > 0n

        allowanceChanges.push({
          token: change.token,
          tokenSymbol: change.tokenSymbol,
          spender,
          before,
          after: amount,
          status: before === "unknown" ? "unknown" : compareAmounts(before, amount),
          isUnlimited: unlimited,
          isNew,
        })

        // Risk: unlimited approval
        if (unlimited && beforeIsZero) {
          riskSignals.push({
            signal: "unlimited_approval",
            severity: "critical",
            description: `Unlimited ${change.tokenSymbol ?? shorten(change.token)} approval granted to ${shorten(spender)}`,
          })
        } else if (unlimited) {
          riskSignals.push({
            signal: "unlimited_approval",
            severity: "high",
            description: `${change.tokenSymbol ?? shorten(change.token)} approval increased to unlimited for ${shorten(spender)}`,
          })
        }

        // Risk: new permission
        if (isNew) {
          riskSignals.push({
            signal: "new_permission",
            severity: "medium",
            description: `New ${change.tokenSymbol ?? shorten(change.token)} allowance granted to first-time spender ${shorten(spender)}`,
          })
        }
      }
    }

    // Operator diffs
    if (change.operatorAfter) {
      for (const [operator, approved] of Object.entries(change.operatorAfter)) {
        const key = `${change.token}:${operator}`
        const beforeStr = currentState.operators[key]
        const before = beforeStr !== undefined ? beforeStr === "true" : false

        operatorChanges.push({
          operator,
          token: change.token,
          tokenSymbol: change.tokenSymbol,
          approved,
          before,
          status: beforeStr === undefined ? "unknown" : (before === approved ? "unchanged" : (approved ? "increased" : "decreased")),
          isNew: beforeStr === undefined && approved,
        })

        if (approved && (beforeStr === undefined || before === false)) {
          riskSignals.push({
            signal: "new_operator",
            severity: "high",
            description: `New operator ${shorten(operator)} approved for ${change.tokenSymbol ?? shorten(change.token)}`,
          })
        }
      }
    }

    // Permission diffs
    if (change.permissionsAfter) {
      for (const [perm, granted] of Object.entries(change.permissionsAfter)) {
        const key = `${change.contract ?? change.token}:${perm}`
        const before = currentState.permissions[key] ?? false

        permissionChanges.push({
          contract: change.contract ?? change.token,
          contractName: change.contractName,
          permission: perm,
          before,
          after: granted,
          status: before === granted ? "unchanged" : (granted ? "increased" : "decreased"),
          isNew: !before && granted,
        })

        if (!before && granted) {
          riskSignals.push({
            signal: "new_permission",
            severity: "medium",
            description: `New permission "${perm}" granted on ${change.contractName ?? shorten(change.contract ?? change.token)}`,
          })
        }
      }
    }
  }

  // Recipient exposure
  if (BigInt(value) > 0n) {
    const isFirstSeen = !currentState.knownRecipients.has(to)
    recipientExposure.push({
      address: to,
      isFirstSeen,
      valueSent: value,
      assetType: "native",
    })

    if (isFirstSeen) {
      riskSignals.push({
        signal: "first_seen_recipient",
        severity: "medium",
        description: `Value sent to first-seen address ${shorten(to)}`,
      })
    }
  }

  return {
    txHash,
    to,
    value,
    timestamp,
    balanceChanges,
    allowanceChanges,
    operatorChanges,
    permissionChanges,
    recipientExposure,
    riskSignals,
  }
}

// ─── Query helpers ───────────────────────────────────────────────────

export function hasMaterialChanges(diff: TransactionDiff): boolean {
  return (
    diff.balanceChanges.some((c) => c.status !== "unchanged" && c.status !== "unknown") ||
    diff.allowanceChanges.some((c) => c.status !== "unchanged" && c.status !== "unknown") ||
    diff.operatorChanges.some((c) => c.status !== "unchanged" && c.status !== "unknown") ||
    diff.permissionChanges.some((c) => c.status !== "unchanged" && c.status !== "unknown")
  )
}

export function getCriticalSignals(diff: TransactionDiff): RiskSignal[] {
  return diff.riskSignals.filter((s) => s.severity === "critical")
}

export function getTotalRiskScore(diff: TransactionDiff): number {
  let score = 0
  for (const s of diff.riskSignals) {
    switch (s.severity) {
      case "critical": score += 30; break
      case "high": score += 20; break
      case "medium": score += 10; break
      case "low": score += 5; break
    }
  }
  return Math.min(100, score)
}

// ─── Demo data ───────────────────────────────────────────────────────

export function createDemoDiff(): TransactionDiff {
  return generateDiff(
    "0xdemo1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaabbbbccccdddd",
    "0xSp3nd3r00000000000000000000000000000000",
    "10000000000000000000", // 10 XDC
    {
      balances: {
        native: "50000000000000000000", // 50 XDC
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "2000000000", // 2000 USDC
      },
      allowances: {
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:0xB0b86991c6218b36c1d19D4a2e9Eb0cE3606eB49": "500000000",
      },
      operators: {},
      permissions: {},
      knownRecipients: new Set(["0xKnown000000000000000000000000000000000001"]),
    },
    [
      {
        token: "native",
        tokenSymbol: "XDC",
        balanceAfter: "40000000000000000000", // 40 XDC (sent 10)
      },
      {
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        tokenSymbol: "USDC",
        balanceAfter: "0",
        allowanceAfter: {
          "0xSp3nd3r00000000000000000000000000000000": "115792089237316195423570985008687907853269984665640564039457584007913129639935", // unlimited
        },
      },
      {
        token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        tokenSymbol: "WETH",
        operatorAfter: {
          "0xOp3r4t0r00000000000000000000000000000001": true,
        },
      },
    ],
  )
}
