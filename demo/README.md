# Demo rehearsal artifacts

Two full, clean runs of the 3-minute demo script (`docs/demo-script.md`),
captured end-to-end with `script(1)` — including the deploy output and the
complete watcher pipeline log for every transaction.

| File | Result |
|------|--------|
| `rehearsal-run-1.txt` | ✅ benign: reverted → scored 0 → succeeded · attack: score 90 → reverted on both attempts · drain: reverted, NFT safe |
| `rehearsal-run-2.txt` | ✅ identical sequence, second independent run |

## These are the fallback recording

If the live demo hits testnet/API flakiness, open `rehearsal-run-2.txt`
in a terminal (or a terminal-replay tool) and walk the audience through
it — it shows every expected line, including the rule engine's matched
signals and the on-chain verdict submissions.

## Reproduce

```bash
bash scripts/demo/rehearse.sh
```

The driver starts a local chain, deploys everything, runs the watcher,
executes all five demo steps, prints the watcher log, and writes a fresh
`demo/rehearsal-run-$(date +%s).txt`.
