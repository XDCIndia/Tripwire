/**
 * Issue #81: Frontend Transaction Intent Decoder
 *
 * Converts raw Safe transaction calldata into a human-readable
 * description of what the transaction will actually do. Never
 * fabricates interpretations when decoding is incomplete.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type IntentType =
  | "transfer"
  | "approval"
  | "operator_approval"
  | "permit"
  | "contract_call"
  | "native_transfer"
  | "unknown"

export type RiskIndicator =
  | "unlimited_approval"
  | "operator_approval"
  | "first_seen_counterparty"
  | "unknown_target"
  | "high_value"
  | "dangerous_function"

export interface DecodedParameter {
  name: string
  type: string
  value: string
  humanReadable?: string
}

export interface TransactionIntent {
  /** Whether decoding succeeded */
  decoded: boolean
  /** Type of transaction */
  type: IntentType
  /** Target contract address */
  targetAddress: string
  /** Function name (or "Unknown") */
  functionName: string
  /** Function selector (first 4 bytes) */
  selector: string
  /** Decoded parameters */
  parameters: DecodedParameter[]
  /** Token/asset symbol if identifiable */
  tokenSymbol?: string
  /** Token contract address */
  tokenAddress?: string
  /** Recipient address (for transfers) */
  recipientAddress?: string
  /** Spender address (for approvals) */
  spenderAddress?: string
  /** Operator address (for setApprovalForAll) */
  operatorAddress?: string
  /** NFT collection address (for setApprovalForAll) */
  collectionAddress?: string
  /** Amount (human-readable) */
  amount?: string
  /** Whether amount is unlimited */
  isUnlimited?: boolean
  /** Approval scope */
  approvalScope?: string
  /** Native value transferred (wei) */
  nativeValue?: string
  /** Security risk indicators */
  riskIndicators: RiskIndicator[]
  /** Human-readable intent summary */
  intentSummary: string
  /** Security warning messages */
  warnings: string[]
  /** Transaction hash this decode is bound to */
  txHash: string
}

// ─── Known function selectors ────────────────────────────────────────

interface FunctionSignature {
  name: string
  type: IntentType
  inputs: { name: string; type: string }[]
}

const FUNCTION_SELECTORS: Record<string, FunctionSignature> = {
  // ERC20 transfer(address,uint256)
  "0xa9059cbb": {
    name: "transfer",
    type: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  // ERC20 transferFrom(address,address,uint256)
  "0x23b872dd": {
    name: "transferFrom",
    type: "transfer",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  // ERC20 approve(address,uint256)
  "0x095ea7b3": {
    name: "approve",
    type: "approval",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  // ERC721/ERC1155 setApprovalForAll(address,bool)
  "0xa22cb465": {
    name: "setApprovalForAll",
    type: "operator_approval",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
  },
  // ERC2612 permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  "0xd505accf": {
    name: "permit",
    type: "permit",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────

const MAX_UINT256 = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")

function shorten(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

function formatAmount(wei: string, decimals = 18): string {
  try {
    const big = BigInt(wei)
    if (big === 0n) return "0"
    const whole = big / (10n ** BigInt(decimals))
    const frac = big % (10n ** BigInt(decimals))
    if (frac === 0n) return whole.toString()
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "")
    return `${whole}.${fracStr}`
  } catch {
    return wei
  }
}

function isUnlimitedAmount(amount: string): boolean {
  try {
    return BigInt(amount) >= MAX_UINT256
  } catch {
    return false
  }
}

// ─── Unknown intent factory ──────────────────────────────────────────

function makeUnknownIntent(targetAddress: string, txHash: string, reason: string): TransactionIntent {
  return {
    decoded: false,
    type: "unknown",
    targetAddress,
    functionName: "Unknown",
    selector: "0x????????",
    parameters: [],
    riskIndicators: ["unknown_target"],
    intentSummary: "Transaction intent could not be determined",
    warnings: [
      "Tripwire could not safely decode this transaction's calldata.",
      reason,
      "Security preview unavailable.",
      "Do not interpret this transaction as safe based on missing information.",
    ],
    txHash,
  }
}

// ─── Calldata decoder ────────────────────────────────────────────────

export function decodeCalldata(
  calldata: string,
  targetAddress: string,
  txHash: string,
  options?: {
    knownTokens?: Record<string, string> // address -> symbol
    knownRecipients?: Set<string>
  },
): TransactionIntent {
  const warnings: string[] = []
  const riskIndicators: RiskIndicator[] = []

  // Clean calldata
  const data = calldata.startsWith("0x") ? calldata.slice(2) : calldata

  if (data.length < 8) {
    return makeUnknownIntent(targetAddress, txHash, "Calldata too short to decode")
  }

  // Extract selector
  const selector = `0x${data.slice(0, 8)}`
  const sig = FUNCTION_SELECTORS[selector]

  if (!sig) {
    return makeUnknownIntent(targetAddress, txHash, `Unknown function selector: ${selector}`)
  }

  // Extract parameter data
  const paramData = data.slice(8)
  const params: DecodedParameter[] = []

  let cursor = 0
  for (const input of sig.inputs) {
    const chunk = paramData.slice(cursor, cursor + 64)
    if (chunk.length < 64) {
      warnings.push(`Incomplete calldata for parameter ${input.name}`)
      break
    }
    cursor += 64

    let value: string
    let humanReadable: string | undefined

    switch (input.type) {
      case "address":
        value = `0x${chunk.slice(24)}`
        humanReadable = shorten(value)
        break
      case "uint256":
        value = BigInt(`0x${chunk}`).toString()
        humanReadable = value
        break
      case "bool":
        value = chunk === "0".repeat(63) + "1" ? "true" : "false"
        humanReadable = value
        break
      case "bytes32":
        value = `0x${chunk}`
        humanReadable = `0x${chunk.slice(0, 8)}…`
        break
      default:
        value = `0x${chunk}`
        humanReadable = chunk
    }

    params.push({ name: input.name, type: input.type, value, humanReadable })
  }

  // Build base intent
  const intent: TransactionIntent = {
    decoded: true,
    type: sig.type,
    targetAddress,
    functionName: sig.name,
    selector,
    parameters: params,
    riskIndicators,
    intentSummary: "",
    warnings,
    txHash,
  }

  // Enrich based on function type
  switch (sig.type) {
    case "transfer":
      enrichTransfer(intent, params, options)
      break
    case "approval":
      enrichApproval(intent, params, options)
      break
    case "operator_approval":
      enrichOperatorApproval(intent, params, options)
      break
    case "permit":
      enrichPermit(intent, params, options)
      break
  }

  return intent
}

// ─── Enrichment functions ────────────────────────────────────────────

function enrichTransfer(
  intent: TransactionIntent,
  params: DecodedParameter[],
  options?: { knownTokens?: Record<string, string>; knownRecipients?: Set<string> },
) {
  const toParam = params.find((p) => p.name === "to")
  const amountParam = params.find((p) => p.name === "amount")

  intent.recipientAddress = toParam?.value
  intent.amount = amountParam?.value ? formatAmount(amountParam.value) : undefined

  if (toParam?.value && options?.knownRecipients && !options.knownRecipients.has(toParam.value)) {
    intent.riskIndicators.push("first_seen_counterparty")
    intent.warnings.push(`Recipient ${shorten(toParam.value)} has not been transacted with before.`)
  }

  if (options?.knownTokens?.[intent.targetAddress]) {
    intent.tokenSymbol = options.knownTokens[intent.targetAddress]
    intent.tokenAddress = intent.targetAddress
    intent.intentSummary = `Transfer ${intent.amount} ${intent.tokenSymbol} to ${shorten(intent.recipientAddress ?? "")}`
  } else {
    intent.intentSummary = `Transfer to ${shorten(intent.recipientAddress ?? "")}`
  }
}

function enrichApproval(
  intent: TransactionIntent,
  params: DecodedParameter[],
  options?: { knownTokens?: Record<string, string> },
) {
  const spenderParam = params.find((p) => p.name === "spender")
  const amountParam = params.find((p) => p.name === "amount")

  intent.spenderAddress = spenderParam?.value
  intent.amount = amountParam?.value ? formatAmount(amountParam.value) : undefined
  intent.isUnlimited = amountParam?.value ? isUnlimitedAmount(amountParam.value) : false
  intent.approvalScope = intent.isUnlimited ? "unlimited" : "limited"

  if (options?.knownTokens?.[intent.targetAddress]) {
    intent.tokenSymbol = options.knownTokens[intent.targetAddress]
    intent.tokenAddress = intent.targetAddress
  }

  if (intent.isUnlimited) {
    intent.riskIndicators.push("unlimited_approval")
    intent.warnings.push(`Unlimited ${intent.tokenSymbol ?? "token"} approval granted to ${shorten(intent.spenderAddress ?? "")}.`)
    intent.intentSummary = `Grant unlimited ${intent.tokenSymbol ?? "token"} spending approval`
  } else {
    intent.intentSummary = `Approve ${intent.amount} ${intent.tokenSymbol ?? "tokens"} for ${shorten(intent.spenderAddress ?? "")}`
  }
}

function enrichOperatorApproval(
  intent: TransactionIntent,
  params: DecodedParameter[],
  options?: { knownTokens?: Record<string, string> },
) {
  const operatorParam = params.find((p) => p.name === "operator")
  const approvedParam = params.find((p) => p.name === "approved")

  intent.operatorAddress = operatorParam?.value
  intent.collectionAddress = intent.targetAddress

  if (options?.knownTokens?.[intent.targetAddress]) {
    intent.tokenSymbol = options.knownTokens[intent.targetAddress]
  }

  const approved = approvedParam?.value === "true"
  if (approved) {
    intent.riskIndicators.push("operator_approval")
    intent.warnings.push(`This transaction gives ${shorten(intent.operatorAddress ?? "")} control over all tokens in this collection.`)
    intent.intentSummary = `Grant operator control to ${shorten(intent.operatorAddress ?? "")}`
  } else {
    intent.intentSummary = `Revoke operator control from ${shorten(intent.operatorAddress ?? "")}`
  }
}

function enrichPermit(
  intent: TransactionIntent,
  params: DecodedParameter[],
  options?: { knownTokens?: Record<string, string> },
) {
  const spenderParam = params.find((p) => p.name === "spender")
  const valueParam = params.find((p) => p.name === "value")

  intent.spenderAddress = spenderParam?.value
  intent.amount = valueParam?.value ? formatAmount(valueParam.value) : undefined
  intent.isUnlimited = valueParam?.value ? isUnlimitedAmount(valueParam.value) : false
  intent.approvalScope = intent.isUnlimited ? "unlimited" : "limited"

  if (options?.knownTokens?.[intent.targetAddress]) {
    intent.tokenSymbol = options.knownTokens[intent.targetAddress]
    intent.tokenAddress = intent.targetAddress
  }

  if (intent.isUnlimited) {
    intent.riskIndicators.push("unlimited_approval")
    intent.warnings.push(`Permit grants unlimited ${intent.tokenSymbol ?? "token"} approval to ${shorten(intent.spenderAddress ?? "")}.`)
    intent.intentSummary = `Sign permit for unlimited ${intent.tokenSymbol ?? "token"} spending`
  } else {
    intent.intentSummary = `Sign permit for ${intent.amount} ${intent.tokenSymbol ?? "tokens"}`
  }
}

// ─── Native transfer decoder ─────────────────────────────────────────

export function decodeNativeTransfer(
  targetAddress: string,
  value: string,
  txHash: string,
): TransactionIntent {
  const warnings: string[] = []
  const riskIndicators: RiskIndicator[] = []

  const amount = formatAmount(value)
  const isHighValue = BigInt(value) > BigInt("10000000000000000000") // > 10 XDC

  if (isHighValue) {
    riskIndicators.push("high_value")
    warnings.push(`High-value native transfer: ${amount} XDC`)
  }

  return {
    decoded: true,
    type: "native_transfer",
    targetAddress,
    functionName: "Native Transfer",
    selector: "0x",
    parameters: [],
    nativeValue: value,
    recipientAddress: targetAddress,
    amount,
    riskIndicators,
    intentSummary: `Transfer ${amount} XDC to ${shorten(targetAddress)}`,
    warnings,
    txHash,
  }
}

// ─── Display helpers ─────────────────────────────────────────────────

export function intentTypeLabel(type: IntentType): string {
  switch (type) {
    case "transfer": return "Token Transfer"
    case "approval": return "Token Approval"
    case "operator_approval": return "Operator Approval"
    case "permit": return "Permit (EIP-2612)"
    case "contract_call": return "Contract Interaction"
    case "native_transfer": return "Native Transfer"
    case "unknown": return "Unknown"
  }
}

export function intentTypeColor(type: IntentType): string {
  switch (type) {
    case "transfer": return "#3b82f6"
    case "approval": return "#d97706"
    case "operator_approval": return "#dc2626"
    case "permit": return "#d97706"
    case "contract_call": return "#8b5cf6"
    case "native_transfer": return "#3b82f6"
    case "unknown": return "#6b7280"
  }
}

export function riskIndicatorLabel(indicator: RiskIndicator): string {
  switch (indicator) {
    case "unlimited_approval": return "Unlimited Approval"
    case "operator_approval": return "Operator Approval"
    case "first_seen_counterparty": return "First-Seen Counterparty"
    case "unknown_target": return "Unknown Target"
    case "high_value": return "High Value"
    case "dangerous_function": return "Dangerous Function"
  }
}

export function riskIndicatorColor(indicator: RiskIndicator): string {
  switch (indicator) {
    case "unlimited_approval": return "#dc2626"
    case "operator_approval": return "#dc2626"
    case "first_seen_counterparty": return "#d97706"
    case "unknown_target": return "#d97706"
    case "high_value": return "#d97706"
    case "dangerous_function": return "#dc2626"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX = "0xdemo1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaabbbbccccdddd"

export function createDemoIntents(): TransactionIntent[] {
  return [
    // Unlimited USDC approval
    decodeCalldata(
      "0x095ea7b3000000000000000000000000abcdef1234567890abcdef1234567890abcdef1200000000000000000000000000000000000000000ffffffffffffffffffffffffffffffff",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      DEMO_TX,
      { knownTokens: { "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC" } },
    ),
    // USDC transfer
    decodeCalldata(
      "0x23b872dd000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb222200000000000000000000000000000000000000000000000000000000001312d00",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      `${DEMO_TX}_transfer`,
      { knownTokens: { "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC" }, knownRecipients: new Set(["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbb"]) },
    ),
    // Operator approval (setApprovalForAll)
    decodeCalldata(
      "0xa22cb465000000000000000000000000abcdef1234567890abcdef1234567890abcdef12000000000000000000000000000000000000000000000000000000000000001",
      "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
      `${DEMO_TX}_operator`,
      { knownTokens: { "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D": "BAYC" } },
    ),
    // Unknown
    makeUnknownIntent(`${DEMO_TX}_unknown`, DEMO_TX, "Unknown function selector: 0xdeadbeef"),
  ]
}

// Re-export for internal use
export { makeUnknownIntent as createUnknownIntent }
