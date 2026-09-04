/**
 * Issue #104: Security Decision Counterfactual Engine
 *
 * Evaluates hypothetical future outcomes of a proposed transaction without
 * executing it on-chain. Instead of only answering "Is this risky?" it
 * answers "What state changes could this create, what actions become
 * possible afterward, and how would exposure change under each outcome?"
 *
 * Produces bounded multi-step counterfactual paths from current chain
 * state and proposed transaction. Never represents hypothetical outcomes
 * as confirmed blockchain events.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type DeltaKind =
  | "balance"
  | "allowance"
  | "permission"
  | "ownership"
  | "approval"
  | "role"
  | "contract_relationship"

export interface StateDelta {
  kind: DeltaKind
  asset?: string
  owner: string
  counterparty: string
  /** Before value (null = didn't exist) */
  before: string | null
  /** After value (null = revoked) */
  after: string | null
  /** Human-readable description */
  description: string
}

export interface FollowUpAction {
  /** Function signature or description */
  action: string
  /** Who could execute it */
  executor: string
  /** What it would affect */
  target: string
  /** Risk if executed */
  riskLevel: "low" | "medium" | "high"
  /** Human-readable explanation */
  explanation: string
}

export interface CounterfactualPath {
  /** Step number (0 = the proposed tx itself) */
  step: number
  /** Description of this step */
  description: string
  /** State deltas at this step */
  deltas: StateDelta[]
  /** Follow-up actions enabled by this step */
  followUps: FollowUpAction[]
  /** Cumulative risk score for this path */
  cumulativeRisk: number
}

export interface CounterfactualResult {
  /** The original transaction being analyzed */
  txHash: string
  /** Immediate state changes from the proposed transaction */
  immediateImpact: StateDelta[]
  /** Actions that become possible after the transaction */
  futureCapabilities: FollowUpAction[]
  /** Bounded counterfactual exploration paths */
  paths: CounterfactualPath[]
  /** Total assets that could be exposed */
  potentialExposure: AssetExposure[]
  /** What must be true for this path to be valid */
  preconditions: string[]
  /** Confidence in the analysis (0-1) */
  confidence: number
  /** Overall risk level */
  riskLevel: "low" | "medium" | "high" | "critical"
  /** Recommended action */
  recommendedAction: "allow" | "delay" | "block" | "freeze"
  /** Human-readable summary */
  summary: string
}

export interface AssetExposure {
  asset: string
  /** Maximum amount that could be lost */
  maxExposure: bigint
  /** Whether the exposure is reversible */
  reversible: boolean
  /** Path that leads to this exposure */
  pathDescription: string
}

/** Minimal chain state the engine needs to reason about a transaction. */
export interface ChainState {
  safeAddress: string
  chainId: number
  /** Token balances: token -> holder -> amount */
  balances: Map<string, Map<string, bigint>>
  /** Allowances: owner -> token -> spender -> amount */
  allowances: Map<string, Map<string, Map<string, bigint>>>
  /** Approval-for-all: owner -> collection -> operator -> approved */
  approvalForAll: Map<string, Map<string, Map<string, boolean>>>
  /** Contract ownership/admin: contract -> role -> holder */
  roles: Map<string, Map<string, string>>
}

/** The proposed transaction to analyze. */
export interface ProposedTx {
  txHash: string
  from: string
  to: string
  value: bigint
  data: string
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_PATH_DEPTH = 4
const SELECTOR_APPROVE = "0x095ea7b3"
const SELECTOR_SET_APPROVAL_FOR_ALL = "0xa22cb465"
const SELECTOR_TRANSFER = "0xa9059cbb"
const SELECTOR_TRANSFER_FROM = "0x23b872dd"
const SELECTOR_PERMIT = "0xd505accf"
const MAX_UINT256 = (1n << 256n) - 1n

// ─── Helpers ─────────────────────────────────────────────────────────

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase()
}

function wordAt(data: string, index: number): string {
  const start = 10 + index * 64
  return data.slice(start, start + 64)
}

function decodeAddress(word: string): string {
  return `0x${word.slice(24).toLowerCase()}`
}

function decodeUint256(word: string): bigint {
  return BigInt(`0x${word}`)
}

function cloneState(state: ChainState): ChainState {
  return {
    safeAddress: state.safeAddress,
    chainId: state.chainId,
    balances: new Map(
      Array.from(state.balances.entries()).map(([token, holders]) => [
        token,
        new Map(holders),
      ]),
    ),
    allowances: new Map(
      Array.from(state.allowances.entries()).map(([owner, tokens]) => [
        owner,
        new Map(
          Array.from(tokens.entries()).map(([token, spenders]) => [
            token,
            new Map(spenders),
          ]),
        ),
      ]),
    ),
    approvalForAll: new Map(
      Array.from(state.approvalForAll.entries()).map(([owner, collections]) => [
        owner,
        new Map(
          Array.from(collections.entries()).map(([collection, operators]) => [
            collection,
            new Map(operators),
          ]),
        ),
      ]),
    ),
    roles: new Map(Array.from(state.roles.entries()).map(([k, v]) => [k, new Map(v)])),
  }
}

// ─── State transition ────────────────────────────────────────────────

function applyTransaction(state: ChainState, tx: ProposedTx): StateDelta[] {
  const deltas: StateDelta[] = []
  const selector = selectorOf(tx.data)

  if (selector === SELECTOR_APPROVE) {
    const spender = decodeAddress(wordAt(tx.data, 0))
    const amount = decodeUint256(wordAt(tx.data, 1))
    const token = tx.to

    // Record the allowance delta
    const ownerAllowances = state.allowances.get(tx.from) ?? new Map()
    const tokenAllowances = ownerAllowances.get(token) ?? new Map()
    const before = tokenAllowances.get(spender) ?? 0n

    tokenAllowances.set(spender, amount)
    ownerAllowances.set(token, tokenAllowances)
    state.allowances.set(tx.from, ownerAllowances)

    deltas.push({
      kind: "allowance",
      asset: token,
      owner: tx.from,
      counterparty: spender,
      before: before.toString(),
      after: amount.toString(),
      description:
        amount === MAX_UINT256
          ? `Unlimited approval granted to ${spender.slice(0, 10)}… for ${token.slice(0, 10)}…`
          : `Approval of ${amount} granted to ${spender.slice(0, 10)}… for ${token.slice(0, 10)}…`,
    })
  } else if (selector === SELECTOR_SET_APPROVAL_FOR_ALL) {
    const operator = decodeAddress(wordAt(tx.data, 0))
    const approved = wordAt(tx.data, 1) !== "0".repeat(64)
    const collection = tx.to

    const ownerApprovals = state.approvalForAll.get(tx.from) ?? new Map()
    const collectionApprovals = ownerApprovals.get(collection) ?? new Map()
    const before = collectionApprovals.get(operator) ?? false

    collectionApprovals.set(operator, approved)
    ownerApprovals.set(collection, collectionApprovals)
    state.approvalForAll.set(tx.from, ownerApprovals)

    deltas.push({
      kind: "approval",
      asset: collection,
      owner: tx.from,
      counterparty: operator,
      before: before ? "true" : "false",
      after: approved ? "true" : "false",
      description: approved
        ? `Operator ${operator.slice(0, 10)}… granted blanket control over all tokens in ${collection.slice(0, 10)}…`
        : `Operator ${operator.slice(0, 10)}… revoked from ${collection.slice(0, 10)}…`,
    })
  } else if (selector === SELECTOR_TRANSFER) {
    const to = decodeAddress(wordAt(tx.data, 0))
    const amount = decodeUint256(wordAt(tx.data, 1))
    const token = tx.to

    // Update balance
    const bal = state.balances.get(token) ?? new Map()
    const senderBal = bal.get(tx.from) ?? 0n
    bal.set(tx.from, senderBal - amount)
    const recipientBal = bal.get(to) ?? 0n
    bal.set(to, recipientBal + amount)
    state.balances.set(token, bal)

    deltas.push({
      kind: "balance",
      asset: token,
      owner: tx.from,
      counterparty: to,
      before: senderBal.toString(),
      after: (senderBal - amount).toString(),
      description: `Transfer of ${amount} from ${tx.from.slice(0, 10)}… to ${to.slice(0, 10)}…`,
    })
  } else if (selector === SELECTOR_TRANSFER_FROM) {
    const from = decodeAddress(wordAt(tx.data, 0))
    const to = decodeAddress(wordAt(tx.data, 1))
    const amount = decodeUint256(wordAt(tx.data, 2))
    const token = tx.to

    const bal = state.balances.get(token) ?? new Map()
    const senderBal = bal.get(from) ?? 0n
    bal.set(from, senderBal - amount)
    const recipientBal = bal.get(to) ?? 0n
    bal.set(to, recipientBal + amount)
    state.balances.set(token, bal)

    deltas.push({
      kind: "balance",
      asset: token,
      owner: from,
      counterparty: to,
      before: senderBal.toString(),
      after: (senderBal - amount).toString(),
      description: `TransferFrom of ${amount} from ${from.slice(0, 10)}… to ${to.slice(0, 10)}… by ${tx.from.slice(0, 10)}…`,
    })
  } else if (tx.value > 0n) {
    // Native token transfer
    const bal = state.balances.get("native") ?? new Map()
    const senderBal = bal.get(tx.from) ?? 0n
    bal.set(tx.from, senderBal - tx.value)
    const recipientBal = bal.get(tx.to) ?? 0n
    bal.set(tx.to, recipientBal + tx.value)
    state.balances.set("native", bal)

    deltas.push({
      kind: "balance",
      asset: "native",
      owner: tx.from,
      counterparty: tx.to,
      before: senderBal.toString(),
      after: (senderBal - tx.value).toString(),
      description: `Native transfer of ${tx.value} wei from ${tx.from.slice(0, 10)}… to ${tx.to.slice(0, 10)}…`,
    })
  } else {
    // Unknown calldata — record as contract interaction
    deltas.push({
      kind: "contract_relationship",
      owner: tx.from,
      counterparty: tx.to,
      before: null,
      after: "interacted",
      description: `Contract interaction with ${tx.to.slice(0, 10)}… (selector: ${selector})`,
    })
  }

  return deltas
}

// ─── Follow-up detection ─────────────────────────────────────────────

function detectFollowUps(state: ChainState, txFrom: string): FollowUpAction[] {
  const actions: FollowUpAction[] = []

  // Check for newly granted allowances that enable transferFrom
  const ownerAllowances = state.allowances.get(txFrom)
  if (ownerAllowances) {
    for (const [token, spenders] of ownerAllowances) {
      for (const [spender, amount] of spenders) {
        if (amount > 0n) {
          actions.push({
            action: `transferFrom(${token}, ..., ${amount})`,
            executor: spender,
            target: txFrom,
            riskLevel: amount === MAX_UINT256 ? "high" : "medium",
            explanation: `${spender.slice(0, 10)}… can now transfer up to ${amount === MAX_UINT256 ? "all" : amount.toString()} of ${token.slice(0, 10)}… from ${txFrom.slice(0, 10)}…`,
          })
        }
      }
    }
  }

  // Check for newly granted operator permissions
  const ownerApprovals = state.approvalForAll.get(txFrom)
  if (ownerApprovals) {
    for (const [collection, operators] of ownerApprovals) {
      for (const [operator, approved] of operators) {
        if (approved) {
          actions.push({
            action: `transferFrom(collection: ${collection}, ...)`,
            executor: operator,
            target: txFrom,
            riskLevel: "high",
            explanation: `${operator.slice(0, 10)}… has blanket permission to transfer ALL tokens in ${collection.slice(0, 10)}…`,
          })
        }
      }
    }
  }

  return actions
}

// ─── Path building ───────────────────────────────────────────────────

function buildPaths(
  state: ChainState,
  initialDeltas: StateDelta[],
  followUps: FollowUpAction[],
): CounterfactualPath[] {
  const paths: CounterfactualPath[] = []

  // Step 0: the proposed transaction itself
  paths.push({
    step: 0,
    description: "Proposed transaction execution",
    deltas: initialDeltas,
    followUps,
    cumulativeRisk: 0,
  })

  if (followUps.length === 0) return paths

  // Build bounded exploration of follow-up steps
  let cumulativeRisk = 0
  const highRiskFollowUps = followUps.filter((f) => f.riskLevel === "high")
  const mediumRiskFollowUps = followUps.filter((f) => f.riskLevel === "medium")

  // Each high-risk follow-up becomes a counterfactual path step
  for (let i = 0; i < Math.min(highRiskFollowUps.length, MAX_PATH_DEPTH - 1); i++) {
    const fu = highRiskFollowUps[i]
    cumulativeRisk += 30
    paths.push({
      step: i + 1,
      description: `Counterfactual: ${fu.action}`,
      deltas: [
        {
          kind: "balance",
          asset: fu.action.includes("(") ? fu.action.split("(")[1]?.split(",")[0] ?? "unknown" : "unknown",
          owner: fu.target,
          counterparty: fu.executor,
          before: "exists",
          after: "drained",
          description: fu.explanation,
        },
      ],
      followUps: [],
      cumulativeRisk: Math.min(cumulativeRisk, 100),
    })
  }

  // Medium-risk follow-ups as additional steps
  for (let i = 0; i < Math.min(mediumRiskFollowUps.length, MAX_PATH_DEPTH - paths.length); i++) {
    const fu = mediumRiskFollowUps[i]
    cumulativeRisk += 15
    paths.push({
      step: paths.length,
      description: `Counterfactual: ${fu.action}`,
      deltas: [
        {
          kind: "allowance",
          owner: fu.target,
          counterparty: fu.executor,
          before: "limited",
          after: "expandable",
          description: fu.explanation,
        },
      ],
      followUps: [],
      cumulativeRisk: Math.min(cumulativeRisk, 100),
    })
  }

  return paths
}

// ─── Exposure calculation ────────────────────────────────────────────

function calculateExposure(
  state: ChainState,
  followUps: FollowUpAction[],
  safeAddress: string,
): AssetExposure[] {
  const exposures: AssetExposure[] = []

  for (const fu of followUps) {
    if (fu.riskLevel === "high") {
      // High-risk follow-up — check if assets could be drained
      for (const [token, holders] of state.balances) {
        const balance = holders.get(safeAddress)
        if (balance !== undefined && balance > 0n) {
          exposures.push({
            asset: token,
            maxExposure: balance,
            reversible: false,
            pathDescription: `${fu.action} → ${fu.explanation}`,
          })
        }
      }
    }
  }

  return exposures
}

// ─── Risk scoring ────────────────────────────────────────────────────

function scoreConsequences(
  deltas: StateDelta[],
  followUps: FollowUpAction[],
  exposures: AssetExposure[],
  paths: CounterfactualPath[],
): { riskLevel: CounterfactualResult["riskLevel"]; recommendedAction: CounterfactualResult["recommendedAction"]; confidence: number; summary: string } {
  let riskScore = 0
  const reasons: string[] = []

  // Weight by delta kinds
  for (const d of deltas) {
    if (d.kind === "allowance" && d.after === MAX_UINT256.toString()) {
      riskScore += 30
      reasons.push("unlimited approval granted")
    } else if (d.kind === "approval" && d.after === "true") {
      riskScore += 35
      reasons.push("blanket operator permission granted")
    } else if (d.kind === "allowance" && d.after !== "0" && d.after !== null) {
      riskScore += 15
      reasons.push("limited approval granted")
    }
  }

  // Weight by follow-up severity
  for (const fu of followUps) {
    if (fu.riskLevel === "high") {
      riskScore += 25
      reasons.push(`${fu.action} becomes possible`)
    } else if (fu.riskLevel === "medium") {
      riskScore += 10
    }
  }

  // Weight by exposure magnitude
  for (const exp of exposures) {
    if (exp.maxExposure > 0n) {
      riskScore += 20
      reasons.push(`${exp.asset} exposure: ${exp.maxExposure.toString()}`)
    }
  }

  // Weight by path depth (more steps = more complex attack)
  const maxDepth = Math.max(...paths.map((p) => p.step), 0)
  if (maxDepth >= 2) {
    riskScore += 10
    reasons.push(`${maxDepth + 1}-step counterfactual path detected`)
  }

  riskScore = Math.min(riskScore, 100)

  let riskLevel: CounterfactualResult["riskLevel"]
  let recommendedAction: CounterfactualResult["recommendedAction"]
  if (riskScore >= 80) {
    riskLevel = "critical"
    recommendedAction = "block"
  } else if (riskScore >= 60) {
    riskLevel = "high"
    recommendedAction = "block"
  } else if (riskScore >= 30) {
    riskLevel = "medium"
    recommendedAction = "delay"
  } else {
    riskLevel = "low"
    recommendedAction = "allow"
  }

  // Confidence based on how many follow-ups we could detect
  const confidence = followUps.length > 0 ? 0.85 : 0.6

  const summary =
    reasons.length > 0
      ? `Counterfactual analysis: ${reasons.join("; ")}. Risk: ${riskLevel}.`
      : `No significant counterfactual risk paths detected. Risk: ${riskLevel}.`

  return { riskLevel, recommendedAction, confidence, summary }
}

// ─── Preconditions ───────────────────────────────────────────────────

function determinePreconditions(followUps: FollowUpAction[]): string[] {
  const preconditions: string[] = []
  for (const fu of followUps) {
    if (fu.riskLevel === "high") {
      preconditions.push(`${fu.executor} must be controlled by an attacker`)
    }
  }
  if (preconditions.length === 0) {
    preconditions.push("No specific preconditions required for observed state changes")
  }
  return preconditions
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run counterfactual analysis on a proposed transaction against the
 * current chain state. Returns a structured result with immediate
 * impact, future capabilities, counterfactual paths, and risk assessment.
 */
export function analyzeCounterfactual(
  state: ChainState,
  tx: ProposedTx,
): CounterfactualResult {
  // 1. Clone state for isolated simulation
  const simState = cloneState(state)

  // 2. Apply transaction to get state deltas
  const immediateImpact = applyTransaction(simState, tx)

  // 3. Detect follow-up actions that become possible
  const futureCapabilities = detectFollowUps(simState, tx.from)

  // 4. Build counterfactual paths
  const paths = buildPaths(simState, immediateImpact, futureCapabilities)

  // 5. Calculate potential exposure
  const potentialExposure = calculateExposure(simState, futureCapabilities, state.safeAddress)

  // 6. Score consequences
  const { riskLevel, recommendedAction, confidence, summary } = scoreConsequences(
    immediateImpact,
    futureCapabilities,
    potentialExposure,
    paths,
  )

  // 7. Determine preconditions
  const preconditions = determinePreconditions(futureCapabilities)

  return {
    txHash: tx.txHash,
    immediateImpact,
    futureCapabilities,
    paths,
    potentialExposure,
    preconditions,
    confidence,
    riskLevel,
    recommendedAction,
    summary,
  }
}
