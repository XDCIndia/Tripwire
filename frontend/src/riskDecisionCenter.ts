/**
 * Issue #79: Frontend Risk Decision Center & Transaction Explainability UI
 *
 * Complete transaction-level view of how a Safe transaction was
 * evaluated: intent, risk score, triggered rules, wallet behavior,
 * simulation, AI reasoning, verdict, and enforcement status.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type VerdictType = "allow" | "hold" | "block" | "pending" | "re_evaluation"
export type EnforcementStatus = "none" | "submitted" | "confirmed" | "failed" | "pending"
export type SignalStatus = "triggered" | "passed" | "pending" | "error"
export type SeverityLevel = "low" | "medium" | "high" | "critical"

export interface TransactionHeader {
  txHash: string
  safeAddress: string
  chain: string
  chainId: number
  timestamp: string
  destination: string
  value: string
  calldata: string
  nonce?: number
}

export interface RiskSummary {
  score: number // 0-100
  verdict: VerdictType
  severity: SeverityLevel
  confidence: number // 0-1
  decisionTimestamp: string
  /** Brief explanation */
  summary: string
}

export interface RiskSignal {
  id: string
  /** Source category */
  source: "rule_engine" | "wallet_behavior" | "simulation" | "ai_reasoning" | "contract_risk"
  /** Signal name */
  name: string
  /** Status */
  status: SignalStatus
  /** Risk contribution score */
  score: number
  /** Severity */
  severity: SeverityLevel
  /** Human-readable reason */
  reason: string
  /** Supporting evidence */
  evidence: string[]
}

export interface TransactionIntent {
  /** Human-readable intent summary */
  summary: string
  /** Action type */
  action: string
  /** Token/asset involved */
  token?: string
  /** Amount */
  amount?: string
  /** From address */
  from?: string
  /** To/recipient address */
  to?: string
  /** Spender (for approvals) */
  spender?: string
  /** Whether this is a dangerous operation */
  isDangerous: boolean
  /** Warning messages */
  warnings: string[]
}

export interface SimulationResult {
  /** Whether simulation ran */
  completed: boolean
  /** Whether the call would succeed on-chain */
  wouldSucceed: boolean
  /** Predicted state changes */
  stateChanges: string[]
  /** Unexpected behaviors detected */
  anomalies: string[]
}

export interface AIAnalysis {
  /** Whether AI analysis is complete */
  completed: boolean
  /** AI confidence in its analysis */
  confidence: number
  /** Plain-English reasoning */
  reasoning: string
  /** Key findings */
  findings: string[]
  /** Risk factors identified */
  riskFactors: string[]
}

export interface TimelineEvent {
  /** Event timestamp */
  timestamp: string
  /** Event label */
  label: string
  /** Event status */
  status: "completed" | "pending" | "error"
  /** Optional detail */
  detail?: string
}

export interface EnforcementInfo {
  status: EnforcementStatus
  /** Whether verdict and enforcement match */
  consistent: boolean
  /** Enforcement timestamp */
  timestamp?: string
  /** Guard state if available */
  guardState?: string
  /** Transaction hash of enforcement tx */
  enforcementTxHash?: string
}

export interface RiskDecision {
  transaction: TransactionHeader
  summary: RiskSummary
  signals: RiskSignal[]
  intent: TransactionIntent
  simulation: SimulationResult
  aiAnalysis: AIAnalysis
  timeline: TimelineEvent[]
  enforcement: EnforcementInfo
}

// ─── Display helpers ─────────────────────────────────────────────────

export function verdictColor(verdict: VerdictType): string {
  switch (verdict) {
    case "allow": return "#16a34a"
    case "hold": return "#d97706"
    case "block": return "#dc2626"
    case "pending": return "#6b7280"
    case "re_evaluation": return "#8b5cf6"
  }
}

export function verdictLabel(verdict: VerdictType): string {
  switch (verdict) {
    case "allow": return "ALLOWED"
    case "hold": return "HOLD"
    case "block": return "BLOCKED"
    case "pending": return "PENDING"
    case "re_evaluation": return "RE-EVALUATION"
  }
}

export function verdictEmoji(verdict: VerdictType): string {
  switch (verdict) {
    case "allow": return "🟢"
    case "hold": return "🟡"
    case "block": return "🔴"
    case "pending": return "⚪"
    case "re_evaluation": return "🟣"
  }
}

export function severityColor(severity: SeverityLevel): string {
  switch (severity) {
    case "critical": return "#dc2626"
    case "high": return "#ea580c"
    case "medium": return "#d97706"
    case "low": return "#16a34a"
  }
}

export function severityLabel(severity: SeverityLevel): string {
  return severity.toUpperCase()
}

export function statusColor(status: SignalStatus): string {
  switch (status) {
    case "triggered": return "#dc2626"
    case "passed": return "#16a34a"
    case "pending": return "#d97706"
    case "error": return "#6b7280"
  }
}

export function enforcementColor(status: EnforcementStatus): string {
  switch (status) {
    case "confirmed": return "#16a34a"
    case "submitted": return "#d97706"
    case "failed": return "#dc2626"
    case "pending": return "#6b7280"
    case "none": return "#6b7280"
  }
}

export function sourceLabel(source: RiskSignal["source"]): string {
  switch (source) {
    case "rule_engine": return "Rule Engine"
    case "wallet_behavior": return "Wallet Behavior"
    case "simulation": return "Simulation"
    case "ai_reasoning": return "AI Reasoning"
    case "contract_risk": return "Contract Risk"
  }
}

export function sourceColor(source: RiskSignal["source"]): string {
  switch (source) {
    case "rule_engine": return "#3b82f6"
    case "wallet_behavior": return "#8b5cf6"
    case "simulation": return "#0ea5e9"
    case "ai_reasoning": return "#a855f7"
    case "contract_risk": return "#ea580c"
  }
}

// ─── Shorten helpers ─────────────────────────────────────────────────

export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX = "0xdemo1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaabbbbccccdddd"
const DEMO_SAFE = "0xSafe000000000000000000000000000000000001"
const DEMO_DEST = "0xSp3nd3r00000000000000000000000000000000"

export function createDemoDecision(): RiskDecision {
  const now = new Date()
  const t = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString()

  return {
    transaction: {
      txHash: DEMO_TX,
      safeAddress: DEMO_SAFE,
      chain: "XDC Mainnet",
      chainId: 50,
      timestamp: t(60),
      destination: DEMO_DEST,
      value: "50000000000000000000", // 50 XDC
      calldata: "0x095ea7b3000000000000000000000000abcdef1234567890abcdef1234567890abcdef12ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      nonce: 42,
    },
    summary: {
      score: 82,
      verdict: "block",
      severity: "critical",
      confidence: 0.94,
      decisionTimestamp: t(3),
      summary: "Critical risk: unlimited token approval to first-seen unverified counterparty with abnormal value transfer.",
    },
    signals: [
      {
        id: "sig-1",
        source: "rule_engine",
        name: "Unlimited Approval",
        status: "triggered",
        score: 40,
        severity: "critical",
        reason: "approve() called with type(uint256).max — grants unrestricted spending permission.",
        evidence: ["Selector: 0x095ea7b3", "Amount: 0xffffffffffff…ffff (unlimited)", "Token: USDC (0xA0b8…eB48)"],
      },
      {
        id: "sig-2",
        source: "wallet_behavior",
        name: "First-Seen Counterparty",
        status: "triggered",
        score: 20,
        severity: "high",
        reason: "This wallet has never transacted with the target address before.",
        evidence: ["Target: 0xSp3nd…0000", "Previous transactions: 0", "First interaction: today"],
      },
      {
        id: "sig-3",
        source: "simulation",
        name: "Unexpected Asset Movement",
        status: "triggered",
        score: 15,
        severity: "high",
        reason: "Simulation detected full token balance would be transferrable after approval.",
        evidence: ["USDC balance: 12,500", "Post-approval exposure: 12,500 USDC", "Historical spend to this address: 0"],
      },
      {
        id: "sig-4",
        source: "ai_reasoning",
        name: "Risk Pattern Match",
        status: "triggered",
        score: 7,
        severity: "medium",
        reason: "Transaction pattern matches known token-draining attack vectors.",
        evidence: ["Pattern: unlimited approve → first-seen → high value", "Similar to 3 documented incidents", "Confidence: 87%"],
      },
      {
        id: "sig-5",
        source: "contract_risk",
        name: "Unverified Contract",
        status: "triggered",
        score: 0,
        severity: "medium",
        reason: "Target contract is not verified on the block explorer.",
        evidence: ["Contract: 0xSp3nd…0000", "Verification status: unverified", "Age: 2 days"],
      },
      {
        id: "sig-6",
        source: "rule_engine",
        name: "Normal Transfer Amount",
        status: "passed",
        score: 0,
        severity: "low",
        reason: "Transaction value is within normal spending range.",
        evidence: ["Value: 50 XDC", "Daily average: 120 XDC", "Within 1σ of baseline"],
      },
    ],
    intent: {
      summary: "Grant unlimited USDC spending approval",
      action: "ERC20 approve",
      token: "USDC",
      amount: "unlimited",
      from: DEMO_SAFE,
      to: DEMO_DEST,
      spender: DEMO_DEST,
      isDangerous: true,
      warnings: [
        "Unlimited approval grants the spender unrestricted ability to transfer all USDC from this Safe.",
        "This is the most common vector in token-draining attacks.",
      ],
    },
    simulation: {
      completed: true,
      wouldSucceed: true,
      stateChanges: [
        "USDC allowance: 0 → unlimited for 0xSp3nd…0000",
        "No balance change in this transaction (approval only)",
      ],
      anomalies: [
        "Full token balance becomes transferable to unknown address",
        "No spending cap or time limit on approval",
      ],
    },
    aiAnalysis: {
      completed: true,
      confidence: 0.94,
      reasoning: "This transaction grants an unlimited ERC20 approval to an address that has never been interacted with by this Safe. The target contract is unverified and only 2 days old. The pattern matches known token-draining attack vectors where an attacker tricks a multisig into approving unlimited spending, then drains the balance in a subsequent transaction. The combination of unlimited approval, first-seen counterparty, and unverified contract creates a critical risk profile.",
      findings: [
        "Unlimited approval is the primary risk factor",
        "Target address has no transaction history with this Safe",
        "Contract is unverified and recently deployed",
        "Pattern matches documented drain attacks",
      ],
      riskFactors: [
        "Unlimited ERC20 approval",
        "First-seen counterparty",
        "Unverified contract",
        "High-value exposure (12,500 USDC)",
      ],
    },
    timeline: [
      { timestamp: t(58), label: "Transaction detected", status: "completed" },
      { timestamp: t(55), label: "Intent decoded", status: "completed", detail: "ERC20 approve — unlimited USDC" },
      { timestamp: t(52), label: "Rule analysis completed", status: "completed", detail: "3 rules triggered" },
      { timestamp: t(48), label: "Wallet behavior analyzed", status: "completed", detail: "First-seen counterparty" },
      { timestamp: t(42), label: "Simulation completed", status: "completed", detail: "Would succeed — full exposure" },
      { timestamp: t(35), label: "AI analysis completed", status: "completed", detail: "Risk pattern match" },
      { timestamp: t(3), label: "Verdict: BLOCK", status: "completed", detail: "Score: 82/100" },
      { timestamp: t(2), label: "Enforcement submitted", status: "completed" },
      { timestamp: t(1), label: "Enforcement confirmed", status: "completed", detail: "Guard frozen" },
    ],
    enforcement: {
      status: "confirmed",
      consistent: true,
      timestamp: t(1),
      guardState: "frozen",
      enforcementTxHash: "0xenf000000000000000000000000000000000000000000000000000000000dead",
    },
  }
}
