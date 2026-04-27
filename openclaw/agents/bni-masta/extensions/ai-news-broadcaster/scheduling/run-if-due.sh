#!/bin/bash
# scheduling/run-if-due.sh — invoked by the LaunchAgent at 09:00 Taipei daily.
#
# Decides whether to actually run broadcast.mjs based on a 20-hour gate.
# v3 cadence is daily at 09:00 Taipei; the 20-hour gate (a) absorbs DST shifts
# and Mac sleep-recovery wake-ups without permitting two runs the same day,
# (b) lets the daily 09:00 fire always pass once the prior day's run is older
# than 20 hours. State file:
#   <vault>/logs/ai_news/last_run_date
#
# On successful broadcast.mjs exit, writes today's Taipei date into the state
# file. Subsequent sub-20-hour wake-ups exit cleanly without doing anything.
#
# This script is deliberately self-contained (no Node, no npm) so it can run
# under launchd's stripped environment without surprises. Logs to stdout/err,
# captured by the LaunchAgent into <vault>/logs/ai_news/launchd-{out,err}.log.
set -uo pipefail

# ── Locate the extension root (this script lives in scheduling/) ────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load secrets so vault-root env vars are visible ─────────────────────────
SECRETS_FILE="${BNI_SECRETS_FILE:-$HOME/.openclaw/secrets/bni-masta.env}"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
fi

# ── Resolve vault root (same precedence broadcast.mjs uses) ─────────────────
VAULT="${BNI_VAULT_ROOT:-${BNI_VAULT_DIR:-<vault-path>}}"
LOG_DIR="$VAULT/logs/ai_news"
STATE_FILE="$LOG_DIR/last_run_date"
mkdir -p "$LOG_DIR"

stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

# ── 20-hour gate (v3 daily cadence) ────────────────────────────────────────────────────────────
NOW_TS=$(date +%s)
if [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]; then
  LAST_RUN_DATE=$(cat "$STATE_FILE")
else
  LAST_RUN_DATE="1970-01-01"
fi

# macOS BSD `date` parsing
LAST_RUN_TS=$(date -j -f "%Y-%m-%d" "$LAST_RUN_DATE" +%s 2>/dev/null || echo 0)
HOURS_SINCE=$(( (NOW_TS - LAST_RUN_TS) / 3600 ))

echo "[$(stamp)] [run-if-due] last_run_date=$LAST_RUN_DATE hours_since=$HOURS_SINCE vault=$VAULT"

if [ "$HOURS_SINCE" -lt 20 ]; then
  echo "[$(stamp)] [run-if-due] gate=BLOCKED — only $HOURS_SINCE hours since last run (require >= 20); exiting cleanly."
  exit 0
fi

# ── Pre-flight: locate node ────────────────────────────────────────────────
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[$(stamp)] [run-if-due] ✗ node not on PATH ($PATH) — install Node.js or fix PATH in com.bni-masta.ai-news.plist"
  exit 1
fi

echo "[$(stamp)] [run-if-due] gate=PASS — invoking broadcast.mjs with $NODE_BIN"

# ── Invoke broadcast.mjs ───────────────────────────────────────────────────
cd "$EXT_ROOT"
"$NODE_BIN" skills/ai-news-broadcast/broadcast.mjs --staggered
RC=$?

if [ "$RC" -eq 0 ]; then
  TODAY_TAIPEI=$(TZ=Asia/Taipei date +%Y-%m-%d)
  echo "$TODAY_TAIPEI" > "$STATE_FILE"
  echo "[$(stamp)] [run-if-due] ✓ broadcast.mjs succeeded; state_file updated to $TODAY_TAIPEI"
  exit 0
fi

echo "[$(stamp)] [run-if-due] ✗ broadcast.mjs exited $RC; state_file unchanged ($LAST_RUN_DATE) — next 09:00 wake-up will retry"
exit "$RC"
