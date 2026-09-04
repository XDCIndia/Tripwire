/**
 * Deterministic natural-language -> policy-rule parser (issue #39).
 *
 * The grammar is deliberately small and explicit: the LLM step (when it
 * exists) is allowed to *paraphrase* within this vocabulary, never to invent
 * new semantics - that is what makes the whole pipeline deterministic. It
 * understands the issue's canonical example:
 *
 *   "Allow payments below $500 to previously used addresses.
 *    Delay everything else for 1 hour.
 *    Freeze transactions above $10,000."
 *
 * Each sentence becomes one rule. Anything a sentence says that this parser
 * cannot map onto the policy model is a hard parse error - the owner gets a
 * precise "I couldn't understand X" instead of a silently misread policy.
 *
 * Matching semantics, once parsed: rules with conditions ("specific" rules)
 * are evaluated in the order written and the first one whose conditions all
 * hold wins. A rule with no conditions is a catch-all ("everything else")
 * that only applies when no specific rule matched, which is what makes
 * "allow X; delay everything else" work as an ordered chain instead of the
 * catch-all silently shadowing the allow.
 */

import {
  type AmountCondition,
  type AmountCurrency,
  type Comparison,
  type PolicyAction,
  type PolicyRule,
  type RecipientKind,
} from "./policyTypes.js"

/** Maps every supported verb to the action it means. Anything else a user
 * leads a sentence with is rejected - no silent reinterpretation. */
const VERB_TO_ACTION: Record<string, PolicyAction> = {
  allow: "ALLOW",
  permit: "ALLOW",
  delay: "DELAY",
  hold: "DELAY",
  queue: "DELAY",
  freeze: "FREEZE",
  block: "FREEZE",
  reject: "FREEZE",
  deny: "FREEZE",
  veto: "FREEZE",
  stop: "FREEZE",
}

const VERB_WORDS = Object.keys(VERB_TO_ACTION).join("|")

/** Words a sentence may contain that carry no policy meaning. Anything left
 * over after parsing that isn't here is reported to the user, so a typo or
 * an unsupported construct fails loudly instead of being silently dropped. */
const FILLER_WORDS = new Set([
  "a", "an", "the", "of", "for", "in", "on", "at", "to", "from", "toward", "towards",
  "payments", "payment", "transaction", "transactions", "transfer", "transfers",
  "withdrawal", "withdrawals", "recipient", "recipients", "address", "addresses",
  "account", "accounts", "wallet", "wallets", "counterparty", "counterparties",
  "are", "is", "be", "made", "going", "out", "sent", "that", "which", "amount",
  "and", "any", "all", "their", "its", "other", "else", "as", "long", "value",
  "each", "single", "individual", "such", "these", "those", "incoming", "outgoing",
  "anything", "everything", "remaining", "future", "upcoming", "pending",
])

// ---------------------------------------------------------------------------
// Durations ("for 1 hour", "for 30 minutes", "for 2 days", "for a week")
// ---------------------------------------------------------------------------

const DURATION_UNIT_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 60 * 60,
  hours: 60 * 60,
  day: 24 * 60 * 60,
  days: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  weeks: 7 * 24 * 60 * 60,
}

const DURATION_UNIT_WORDS = Object.keys(DURATION_UNIT_SECONDS).join("|")

/** "for an hour", "for 1 hour", "for 0.5 hours". Returns seconds or null. */
function parseDuration(text: string): { seconds: number; consumed: string } | null {
  const match = text.match(new RegExp(`for\\s+(an?|\\d+(?:\\.\\d+)?)\\s+(${DURATION_UNIT_WORDS})\\b`, "i"))
  if (!match) return null
  const amount = /^a/iu.test(match[1]) ? 1 : Number(match[1])
  const unit = match[2].toLowerCase()
  return { seconds: Math.round(amount * DURATION_UNIT_SECONDS[unit]), consumed: match[0] }
}

// ---------------------------------------------------------------------------
// Amounts ("below $500", "above $10,000", "over 500 USD", "under 10 wei")
// ---------------------------------------------------------------------------

const CURRENCY_OF_SUFFIX: Record<string, AmountCurrency> = {
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  xdc: "XDC",
  txdc: "XDC",
  native: "XDC",
  wei: "WEI",
}

const AMOUNT_NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`
const CURRENCY_SUFFIX_WORDS = Object.keys(CURRENCY_OF_SUFFIX).join("|")

/** Parses the money token that must immediately follow a comparison keyword.
 * Either a "$" prefix or a currency word suffix is required, so an ordinary
 * number like "500" in prose is never mistaken for an amount on its own. */
function parseAmountToken(text: string): { amount: AmountCondition; consumed: string } | null {
  const match = text.match(
    new RegExp(String.raw`^\s*(\$)\s*(${AMOUNT_NUMBER})|^\s*(${AMOUNT_NUMBER})\s*(${CURRENCY_SUFFIX_WORDS})\b`, "i"),
  )
  if (!match) return null
  const currency: AmountCurrency = match[1]
    ? "USD"
    : (CURRENCY_OF_SUFFIX[match[4].toLowerCase()] ?? "XDC")
  const rawNumber = (match[2] ?? match[3]).replace(/,/g, "")
  const source = match[0].trim()
  return { amount: { comparison: "<", value: rawNumber, currency, source }, consumed: match[0] }
}

const COMPARISON_KEYWORDS: Array<{ re: RegExp; comparison: Comparison }> = [
  // Longer phrases first so "no more than" beats "more than" etc.
  { re: /\bno more than\b/i, comparison: "<=" },
  { re: /\bno less than\b/i, comparison: ">=" },
  { re: /\bgreater than\b/i, comparison: ">" },
  { re: /\bless than\b/i, comparison: "<" },
  { re: /\bmore than\b/i, comparison: ">" },
  { re: /\bat most\b/i, comparison: "<=" },
  { re: /\bat least\b/i, comparison: ">=" },
  { re: /\bup to\b/i, comparison: "<=" },
  { re: /\bexceeding\b/i, comparison: ">" },
  { re: /\bexceeds\b/i, comparison: ">" },
  { re: /\bbelow\b/i, comparison: "<" },
  { re: /\bunder\b/i, comparison: "<" },
  { re: /\babove\b/i, comparison: ">" },
  { re: /\bover\b/i, comparison: ">" },
]

/** Finds the one amount condition a clause expresses: a comparison keyword
 * immediately followed by a money token ("below $500", "above 10,000 XDC"). */
function parseAmountCondition(text: string): { condition: AmountCondition; consumed: string } | null {
  for (const { re, comparison } of COMPARISON_KEYWORDS) {
    const keyword = text.match(re)
    if (!keyword) continue
    const rest = text.slice((keyword.index ?? 0) + keyword[0].length)
    const parsed = parseAmountToken(rest)
    if (!parsed) continue
    const consumed = keyword[0] + parsed.consumed
    return { condition: { ...parsed.amount, comparison }, consumed }
  }
  return null
}

// ---------------------------------------------------------------------------
// Recipients ("to previously used addresses", "to known recipients",
// "to unknown accounts", "from new addresses")
// ---------------------------------------------------------------------------

const KNOWN_RECIPIENT_RE =
  /\b(?:to|from|toward|towards)?\s*(?:previously[\s-]used|already[\s-]used|known|trusted|familiar)\b/i
const UNKNOWN_RECIPIENT_RE =
  /\b(?:to|from|toward|towards)?\s*(?:new|unknown|unseen|unfamiliar|first[\s-]time|first[\s-]seen|never[\s-]before[\s-]seen)\b/i

function parseRecipient(text: string): { kind: RecipientKind; consumed: string } | null {
  const known = text.match(KNOWN_RECIPIENT_RE)
  const unknown = text.match(UNKNOWN_RECIPIENT_RE)
  if (known && unknown) {
    throw new PolicyParseError(text, `both "known" and "unknown" recipients in one rule - pick one`)
  }
  if (known) return { kind: "known", consumed: known[0] }
  if (unknown) return { kind: "unknown", consumed: unknown[0] }
  return null
}

// ---------------------------------------------------------------------------
// Clause assembly
// ---------------------------------------------------------------------------

export class PolicyParseError extends Error {
  constructor(
    public readonly clause: string,
    public readonly reason: string,
  ) {
    super(`Could not understand ${reason} in: "${clause}"`)
    this.name = "PolicyParseError"
  }
}

/** Splits policy text into clauses on sentence boundaries and on "and"
 * between verbs ("Allow X and delay Y" is two rules). */
function splitClauses(text: string): string[] {
  // Sentence boundaries are periods, semicolons or newlines - but never a
  // period *between two digits*, or "1.5 XDC" would be torn into "1" and
  // "5 XDC". The negative lookahead keeps decimals intact.
  return text
    .replace(/\r/g, " ")
    .split(/[.;\n]+(?![.\d])|\s+and\s+(?=(?:allow|permit|delay|hold|queue|freeze|block|reject|deny|veto|stop)\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function stripSpan(text: string, span: string): string {
  return text.replace(span, " ")
}

/** Every remaining word a clause contains after all recognized spans were
 * removed and that is not plain filler - the audit that turns typos and
 * unsupported constructs into hard errors instead of silent misreads. */
function leftoverWords(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean)
  return tokens.filter((token) => !FILLER_WORDS.has(token))
}

export function parseClause(rawClause: string): PolicyRule {
  const clause = rawClause.replace(/\.+$/, "").trim()

  const verb = clause.match(new RegExp(`^(${VERB_WORDS})\\b`, "i"))
  if (!verb) {
    const firstWord = clause.split(/\s+/)[0] ?? ""
    throw new PolicyParseError(
      clause,
      `"${firstWord}" - every rule must start with one of: ${Object.keys(VERB_TO_ACTION).join(", ")}`,
    )
  }
  const action: PolicyAction = VERB_TO_ACTION[verb[0].toLowerCase()]
  let rest = stripSpan(clause, verb[0]).trim()
  if (!rest) throw new PolicyParseError(clause, "nothing after the action verb")

  // Durations first, so "for 1 hour" is never misread as an amount.
  const duration = parseDuration(rest)
  if (duration) rest = stripSpan(rest, duration.consumed).trim()

  const recipient = parseRecipient(rest)
  if (recipient) rest = stripSpan(rest, recipient.consumed).trim()

  const amount = parseAmountCondition(rest)
  if (amount) rest = stripSpan(rest, amount.consumed).trim()

  // A rule with neither an amount nor a recipient condition matches every
  // transaction, so it *is* the catch-all ("delay everything else"). Keep
  // that meaning explicit rather than letting it silently shadow rules.
  const isCatchAll = !amount && !recipient

  if (isCatchAll && action === "ALLOW") {
    throw new PolicyParseError(
      clause,
      "an allow with no conditions would fail open - Tripwire policies must fail closed",
    )
  }
  if (action === "DELAY" && !duration) {
    throw new PolicyParseError(clause, `a delay needs a length - add "for <n> minutes/hours/days"`)
  }
  if (action !== "DELAY" && duration) {
    throw new PolicyParseError(clause, 'only "delay" rules take a duration - drop the "for <n> ..." part')
  }

  const nonFiller = leftoverWords(rest)
  if (nonFiller.length > 0) {
    throw new PolicyParseError(clause, `"${nonFiller.join(" ")}"`)
  }

  return {
    action,
    amount: amount?.condition ?? null,
    recipient: recipient?.kind ?? null,
    delaySeconds: action === "DELAY" ? duration!.seconds : null,
    fallback: isCatchAll,
    source: rawClause.trim(),
  }
}

export function parsePolicyText(text: string): PolicyRule[] {
  return splitClauses(text).map((clause) => parseClause(clause))
}
