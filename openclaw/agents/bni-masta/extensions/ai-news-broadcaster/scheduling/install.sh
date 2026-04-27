#!/bin/bash
# scheduling/install.sh — install the AI News Broadcaster LaunchAgent.
#
# What this does:
#   1. Validates the plist with `plutil`.
#   2. Copies it to ~/Library/LaunchAgents/com.bni-masta.ai-news.plist
#      (overwriting any prior copy after `launchctl unload`-ing it first).
#   3. Makes run-if-due.sh executable.
#   4. `launchctl load`s the new plist.
#   5. Prints the next-fire time so the operator can confirm.
#
# Run by hand:  bash scheduling/install.sh
# Uninstall:    bash scheduling/uninstall.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.bni-masta.ai-news.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.bni-masta.ai-news.plist"
WRAPPER="$SCRIPT_DIR/run-if-due.sh"
LABEL="com.bni-masta.ai-news"

# ── 1. Validate the plist ──────────────────────────────────────────────────
echo "→ validating $PLIST_SRC ..."
if ! plutil -lint "$PLIST_SRC" >/dev/null; then
  echo "✗ plist failed plutil -lint; not installing."
  exit 1
fi
echo "  ✓ plist syntax OK"

# ── 2. Make the wrapper executable ─────────────────────────────────────────
echo "→ chmod +x $WRAPPER ..."
chmod +x "$WRAPPER"
echo "  ✓ wrapper executable"

# ── 3. Unload any prior copy (idempotent re-install) ───────────────────────
if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "→ existing LaunchAgent found; unloading before re-install ..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# ── 4. Copy the plist into ~/Library/LaunchAgents ──────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"
echo "→ installing plist to $PLIST_DEST ..."
cp "$PLIST_SRC" "$PLIST_DEST"
echo "  ✓ plist installed"

# ── 5. launchctl load ──────────────────────────────────────────────────────
echo "→ launchctl load $PLIST_DEST ..."
launchctl load "$PLIST_DEST"
echo "  ✓ LaunchAgent loaded ($LABEL)"

# ── 6. Sanity check + next-fire time ───────────────────────────────────────
if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "  ✓ launchctl list confirms registration"
else
  echo "✗ launchctl list does NOT see $LABEL — investigate before relying on it"
  exit 1
fi

echo ""
echo "Next-fire time:"
NOW_HOUR=$(date +%H)
if [ "$NOW_HOUR" -lt 9 ]; then
  echo "  $(date '+%Y-%m-%d') 09:00 Taipei (today)"
else
  TOMORROW=$(date -v+1d '+%Y-%m-%d' 2>/dev/null || date -d "tomorrow" '+%Y-%m-%d')
  echo "  $TOMORROW 09:00 Taipei"
fi
echo ""
echo "Note: the LaunchAgent fires DAILY at 09:00. The wrapper (run-if-due.sh)"
echo "      gates broadcast.mjs on a 40-hour state file at"
echo "      <vault>/logs/ai_news/last_run_date — so the user-visible cadence"
echo "      is every ~2 days, not every day. See com.bni-masta.ai-news.plist"
echo "      header comment for the full rationale."
echo ""
echo "Logs:"
echo "  <vault>/logs/ai_news/launchd-out.log"
echo "  <vault>/logs/ai_news/launchd-err.log"
echo ""
echo "Done."
