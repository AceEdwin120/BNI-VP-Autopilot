#!/bin/bash
# scheduling/uninstall.sh — remove the AI News Broadcaster LaunchAgent.
#
# Run by hand:  bash scheduling/uninstall.sh
set -uo pipefail

PLIST_DEST="$HOME/Library/LaunchAgents/com.bni-masta.ai-news.plist"
LABEL="com.bni-masta.ai-news"

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "→ launchctl unload $PLIST_DEST ..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  echo "  ✓ unloaded"
else
  echo "  (LaunchAgent $LABEL was not registered with launchctl)"
fi

if [ -f "$PLIST_DEST" ]; then
  echo "→ removing $PLIST_DEST ..."
  rm -f "$PLIST_DEST"
  echo "  ✓ removed"
else
  echo "  (no plist found at $PLIST_DEST)"
fi

echo ""
echo "Note: this only removes the schedule trigger. The state file at"
echo "      <vault>/logs/ai_news/last_run_date and any archive content under"
echo "      <vault>/{archive,raw,build,logs}/ai_news/ is left intact."
echo "      Delete those by hand if you want a fully clean uninstall."
echo ""
echo "Done."
