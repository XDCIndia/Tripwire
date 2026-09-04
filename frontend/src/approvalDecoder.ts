import { type Address, decodeAbiParameters, toFunctionSelector } from "viem"

// ─── Function selectors ──────────────────────────────────────────────
const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)")
const SET_APPROVAL_FOR_ALL_SELECTOR = toFunctionSelector("setApprovalForAll(address,bool)")
const MAX_UINT256 = (1n << 256n) - 1n

// ─── Types ───────────────────────────────────────────────────────────

export type PermissionKind = "erc20-approve" | "erc721-approveAll" | "erc1155-approveAll"

export type PermissionRisk = "critical" | "high" | "medium" | "low"

export interface ApprovalScope {
  /** Was the calldata a recognized approval method? */
  recognized: boolean
  /** Which approval method was decoded */
  kind: PermissionKind | null
  /** Token / collection address */
  tokenAddress: Address | null
  /** Spender / operator address */
  spender: Address | null
  /** Approved amount (raw bigint) — null for setApprovalForAll */
  approvedAmount: bigint | null
  /** Whether the approval is unlimited (type(uint256).max) */
  isUnlimited: boolean
  /** Whether it's a "revoke" (amount = 0 or approved = false) */
  isRevocation: boolean
  /** For setApprovalForAll: whether operator is being granted or revoked */
  operatorApproved: boolean | null
  /** Current on-chain allowance (null if unknown / not fetched) */
  currentAllowance: bigint | null
  /** Human-readable token name (null if not resolved) */
  tokenName: string | null
  /** Human-readable token symbol (null if not resolved) */
  tokenSymbol: string | null
  /** Token decimals (null if not resolved) */
  tokenDecimals: number | null
  /** Whether the spender has been seen before (caller-provided) */
  isKnownSpender: boolean
  /** Classified risk level */
  risk: PermissionRisk
  /** Risk signals for the UI indicators */
  signals: string[]
  /** Human-readable explanation of the security impact */
  explanation: string
  /** The raw calldata */
  calldata: `0x${string}`
}

export interface ApprovalScopeInput {
  calldata: `0x${string}`
  /** Token address — useful when calldata is from a specific token contract */
  tokenAddress?: Address
  /** Safe / wallet address (the "owner" of the approval) */
  ownerAddress?: Address
  /** Set of known/trusted spender addresses */
  knownSpenders?: Set<string>
  /** Current on-chain allowance for this token+owner+spender triplet */
  currentAllowance?: bigint
  /** Token metadata (resolved off-chain) */
  tokenName?: string
  tokenSymbol?: string
  tokenDecimals?: number
}

// ─── Decoder ─────────────────────────────────────────────────────────

function decodeApprove(calldata: `0x${string}`): { spender: Address; amount: bigint } | null {
  if (!calldata.toLowerCase().startsWith(APPROVE_SELECTOR.toLowerCase())) return null
  try {
    const params = decodeAbiParameters(
      [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }],
      `0x${calldata.slice(10)}`,
    )
    return { spender: params[0] as Address, amount: params[1] as bigint }
  } catch {
    return null
  }
}

function decodeSetApprovalForAll(calldata: `0x${string}`): { operator: Address; approved: boolean } | null {
  const sel = calldata.slice(0, 10).toLowerCase()
  if (sel !== SET_APPROVAL_FOR_ALL_SELECTOR.toLowerCase()) return null
  try {
    const params = decodeAbiParameters(
      [{ type: "address", name: "operator" }, { type: "bool", name: "approved" }],
      `0x${calldata.slice(10)}`,
    )
    return { operator: params[0] as Address, approved: params[1] as boolean }
  } catch {
    return null
  }
}

// ─── Risk classification ─────────────────────────────────────────────

function classifyRisk(scope: ApprovalScope): ApprovalScope {
  const signals: string[] = []
  let risk: PermissionRisk = "low"

  if (scope.isUnlimited) {
    signals.push("unlimited")
    risk = "critical"
  } else if (scope.approvedAmount !== null && scope.approvedAmount > 0n) {
    signals.push("limited")
  }

  if (scope.isRevocation) {
    signals.push("revocation")
    risk = "low"
  }

  if (!scope.isKnownSpender) {
    signals.push("first-seen-spender")
    if (risk === "low") risk = "medium"
    if (risk === "medium" && scope.isUnlimited) risk = "critical"
  }

  if (scope.kind === "erc721-approveAll" || scope.kind === "erc1155-approveAll") {
    signals.push("collection-wide")
    if (risk === "low") risk = "high"
    if (risk === "medium") risk = "high"
  }

  // Increase = new allowance > current allowance
  if (scope.currentAllowance !== null && scope.approvedAmount !== null) {
    if (scope.approvedAmount > scope.currentAllowance && scope.currentAllowance > 0n) {
      signals.push("increase")
      if (risk === "low") risk = "medium"
    }
  }

  scope.risk = risk
  scope.signals = signals
  return scope
}

function buildExplanation(scope: ApprovalScope): string {
  if (!scope.recognized) return "Unrecognized calldata — not a known approval method."

  const tokenLabel = scope.tokenSymbol ?? scope.tokenAddress ?? "Unknown token"
  const spenderLabel = scope.isKnownSpender ? "known spender" : "unknown spender"

  if (scope.isRevocation) {
    return `This transaction revokes approval for ${spenderLabel} on ${tokenLabel}.`
  }

  if (scope.kind === "erc721-approveAll" || scope.kind === "erc1155-approveAll") {
    if (scope.operatorApproved) {
      return `This transaction grants ${spenderLabel} permission to transfer ALL ${tokenLabel} NFTs you own. This is a broad, collection-wide authorization.`
    }
    return `This transaction revokes the operator's permission to manage your ${tokenLabel} NFTs.`
  }

  // ERC-20 approve
  if (scope.isUnlimited) {
    return `This transaction grants ${spenderLabel} ongoing permission to spend any amount of your ${tokenLabel}. This is equivalent to unlimited wallet access for this token.`
  }

  if (scope.approvedAmount !== null && scope.approvedAmount > 0n) {
    const amountStr = scope.tokenDecimals !== null
      ? `${formatAmount(scope.approvedAmount, scope.tokenDecimals)} ${tokenLabel}`
      : `${scope.approvedAmount.toString()} (raw)`
    return `This transaction grants ${spenderLabel} permission to spend ${amountStr}.`
  }

  return `Approval transaction decoded for ${tokenLabel}.`
}

function formatAmount(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0")
  const intPart = str.slice(0, str.length - decimals) || "0"
  const fracPart = str.slice(str.length - decimals)
  // trim trailing zeros
  const fracTrimmed = fracPart.replace(/0+$/, "")
  return fracTrimmed.length > 0 ? `${intPart}.${fracTrimmed}` : intPart
}

// ─── Public API ──────────────────────────────────────────────────────

export function decodeApprovalScope(input: ApprovalScopeInput): ApprovalScope {
  const knownSpenders = input.knownSpenders ?? new Set()

  // Start with a base scope
  const base: ApprovalScope = {
    recognized: false,
    kind: null,
    tokenAddress: input.tokenAddress ?? null,
    spender: null,
    approvedAmount: null,
    isUnlimited: false,
    isRevocation: false,
    operatorApproved: null,
    currentAllowance: input.currentAllowance ?? null,
    tokenName: input.tokenName ?? null,
    tokenSymbol: input.tokenSymbol ?? null,
    tokenDecimals: input.tokenDecimals ?? null,
    isKnownSpender: false,
    risk: "low",
    signals: [],
    explanation: "",
    calldata: input.calldata,
  }

  // Try ERC-20 approve
  const erc20 = decodeApprove(input.calldata)
  if (erc20) {
    const spenderKey = erc20.spender.toLowerCase()
    base.recognized = true
    base.kind = "erc20-approve"
    base.spender = erc20.spender
    base.approvedAmount = erc20.amount
    base.isUnlimited = erc20.amount === MAX_UINT256
    base.isRevocation = erc20.amount === 0n
    base.isKnownSpender = knownSpenders.has(spenderKey)
    classifyRisk(base)
    base.explanation = buildExplanation(base)
    return base
  }

  // Try setApprovalForAll
  const operator = decodeSetApprovalForAll(input.calldata)
  if (operator) {
    const opKey = operator.operator.toLowerCase()
    // Try to distinguish ERC-721 vs ERC-1155 by token decimals (ERC-721 = 0, ERC-1155 = 0)
    // Both use setApprovalForAll — we default to erc721-approveAll
    base.recognized = true
    base.kind = "erc721-approveAll"
    base.spender = operator.operator
    base.operatorApproved = operator.approved
    base.approvedAmount = null
    base.isUnlimited = true // setApprovalForAll is inherently unlimited
    base.isRevocation = !operator.approved
    base.isKnownSpender = knownSpenders.has(opKey)
    classifyRisk(base)
    base.explanation = buildExplanation(base)
    return base
  }

  // Not recognized
  base.explanation = buildExplanation(base)
  return base
}
