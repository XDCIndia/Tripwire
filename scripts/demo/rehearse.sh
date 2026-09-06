#!/bin/bash
# Tripwire 3-minute demo — full headless rehearsal driver.
# Captures: deploy, watcher pipeline, benign flow, attack flow.
set -u
cd /home/parth/zodiac-issue-10
fuser -k 8545/tcp 2>/dev/null; pkill -f localWatcherLoop.ts 2>/dev/null
for i in $(seq 1 15); do
  if ! ss -ltn 2>/dev/null | grep -q ':8545 '; then break; fi
  sleep 2
done
sleep 2
echo "=== Tripwire demo rehearsal — $(date -Is) ==="
echo "--- [1/6] local chain (hardhat node, LOCAL_E2E=true) ---"
LOCAL_E2E=true npx hardhat node > /tmp/demo-hhnode.log 2>&1 &
sleep 10
echo "--- [2/6] deploy Safe + Guard + RiskRegistry + drainer contracts ---"
npx hardhat run scripts/localDeploy.ts --network localhost 2>&1 | tail -14
echo "--- [3/6] start real pipeline watcher ---"
(cd backend && npx tsx scripts/localWatcherLoop.ts > /tmp/demo-watcher.log 2>&1 &)
sleep 6
run() { echo "--- [$1] ACTION=$2 ---"; ACTION=$2 npx hardhat run scripts/localExec.ts --network localhost 2>&1 | grep -E "MINED|SUCCEEDED|Drain reverted|Error" | head -3; sleep 4; }
run "4/6 first benign attempt (expect: reverted, fail-closed)" transfer
run "5/6 retry benign (expect: SUCCEEDED)" transfer
run "6/6 attack: setApprovalForAll attempt (expect: reverted)" approve
run "   attack retry (expect: STILL reverted)" approve
run "   drain check (expect: reverted, NFT safe)" drain
echo "--- watcher pipeline log ---"
cat /tmp/demo-watcher.log
pkill -f localWatcherLoop.ts 2>/dev/null; fuser -k 8545/tcp 2>/dev/null
echo "=== rehearsal complete ==="