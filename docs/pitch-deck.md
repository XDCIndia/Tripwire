# Tripwire — Pitch Deck (finalized)

Slide-by-slide content. Speaker notes in *italics*. One line per slide is
the on-screen headline; bullets are the visual.

---

### Slide 1 — Title
**Tripwire: the guard that sits inside your Safe.**
Wallet-drainer attacks, stopped at the transaction — not after the loss.

*One-liner for us: Tripwire is a Zodiac Guard module: it intercepts every
transaction a Safe tries to execute, scores it in real time, and blocks
what the wallet would regret.*

### Slide 2 — The problem
- $3.4B+ stolen from wallets in the last two years; drainer kits are a commodity
- The signature is already given when the victim notices — current tools scan, warn, or simulate; they can't *stop* anything
- Safes hold treasuries — one bad signature can move everything

### Slide 3 — The idea
**Fail closed, not fail warned.**
- Every Safe transaction routes through the Guard
- No verdict yet → the transaction reverts (fails closed)
- A watcher scores the attempt on-chain and writes a verdict; the retry succeeds or stays blocked forever

### Slide 4 — Live demo (3 minutes)
Benign transfer: blocked once, scored 0, then allowed.
Real drainer payload (`setApprovalForAll`): scored 90, HIGH_RISK — retries never pass.
Drain attempt: reverted — the theft is impossible, not just interrupted.
*(Fallback recording ready — rehearsal logs in `demo/`.)*

### Slide 5 — How it works
```
Safe ──execTransaction──► TripwireGuard ──no verdict?──► REVERT (fail closed)
                            ▲ reads
                     RiskRegistry ◄──verdict── backend pipeline
                                     (watcher → rule engine → relayer)
```
- On-chain: `TripwireGuard` (Zodiac module) + `RiskRegistry`
- Off-chain: shipped, tested pipeline — 12-test Foundry suite on the Guard, 460 backend tests

### Slide 6 — Multi-chain (identical setup, second chain)
**Same contracts, same pipeline, second chain: XDC Apothem.**
The Guard + RiskRegistry deploy with the identical script to XDC Apothem
testnet (chain 51) — one config line, no code changes. See
`docs/APOTHEM_DEPLOYMENT.md`.

### Slide 7 — Why us
- Not a warning — an enforcement layer inside the wallet itself
- Real Zodiac Guard: works with any Safe today (setGuard)
- Composability: any scoring backend; the verdict format is on-chain and auditable

### Slide 8 — Ask
Pilot integrations with Safe treasuries; scoring-oracle partnerships;
testnet feedback.

---

*Deck finalized for the demo rehearsal — slides 4 and 6 verified live.
Changes from the previous draft: Slide 4 updated with the final 3-minute
script (`docs/demo-script.md`); Slide 6 added (Apothem parallel
deployment, issue #25).*
