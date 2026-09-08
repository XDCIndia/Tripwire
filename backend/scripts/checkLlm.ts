/**
 * One real call through `reasonAboutTx`, so you can tell a working LLM pass
 * from a silent fallback. The reasoning path never throws - every failure
 * resolves to `undefined` - which is right for production and useless for
 * telling "the model answered" apart from "the model ID is wrong".
 *
 *   cd backend && npm run check:llm          # key from backend/.env
 *   ANTHROPIC_API_KEY=sk-... npm run check:llm   # or from the environment
 */
// Load backend/.env so the key can live in a gitignored file rather than being
// pasted into a shell (and into shell history).
import "dotenv/config"

import { DEFAULT_MODEL, reasonAboutTx } from "../src/llmReasoning.js"
import { scoreTransaction } from "../src/ruleEngine.js"

const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
console.log(`model: ${model}`)

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FAIL  ANTHROPIC_API_KEY is not set - cannot make a real call.")
  console.error("      Put it in backend/.env (gitignored) or pass it inline.")
  process.exit(1)
}

// The canonical drainer: setApprovalForAll to an unverified, minutes-old contract.
const data = `0xa22cb465${"ab".repeat(20).padStart(64, "0")}${"1".padStart(64, "0")}`
const ruleResult = scoreTransaction({
  data,
  value: 0n,
  isFirstSeenCounterparty: true,
  isUnverifiedOrFreshContract: true,
  counterpartyBlacklist: "unknown",
  historicalP95Value: 0n,
})

// Capture what actually goes over the wire, so a rejected model ID is visible
// rather than being swallowed into the fallback.
let sentModel: string | undefined
let httpStatus: number | undefined
const verdict = await reasonAboutTx(
  { txHash: `0x${"cd".repeat(32)}`, ruleResult },
  {
    fetchImpl: async (url, init) => {
      sentModel = JSON.parse(String((init as RequestInit).body)).model
      const res = await fetch(url as string, init)
      httpStatus = res.status
      return res
    },
  },
)

console.log(`sent model: ${sentModel}`)
console.log(`HTTP status: ${httpStatus}`)

if (verdict) {
  console.log("PASS  the model returned a structured verdict:")
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(0)
}
console.error(`FAIL  reasonAboutTx fell back to undefined (HTTP ${httpStatus}).`)
console.error("      A 404 here means the model ID was rejected.")
process.exit(1)
