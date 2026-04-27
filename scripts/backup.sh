#!/usr/bin/env bash
# BNI-Masta daily backup — snapshots the whole agent (vault + openclaw config
# + secrets + cloudflared + LaunchAgents) into ~/Archive/BNI-Masta-Backups/.
# Runs daily at 03:00 via ai.bnimasta.backup LaunchAgent.

set -euo pipefail

TIMESTAMP="$(date +%Y-%m-%d)"
BACKUP_DIR="$HOME/Archive/BNI-Masta-Backups"
LOG_DIR="$HOME/.openclaw/agents/bni-masta/scripts"
LOG="$LOG_DIR/backup.log"
RETENTION_DAYS=30

VAULT="$HOME/Documents/BNI AGENT/BNI AGENT"
OPENCLAW="$HOME/.openclaw"
CLOUDFLARED="$HOME/.cloudflared"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"
exec >>"$LOG" 2>&1

echo "=== backup started $(date -u +%FT%TZ) ==="

STAGING="$(mktemp -d -t bni-backup.XXXXXX)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

# 1. Vault (raw/ immutable sources, wiki/ compiled pages, PII in members/)
if [[ -d "$VAULT" ]]; then
  mkdir -p "$STAGING/vault"
  rsync -a --delete "$VAULT/" "$STAGING/vault/"
  echo "✓ vault"
else
  echo "✗ vault missing at $VAULT"
fi

# 2. OpenClaw — everything except logs/workspace/delivery-queue (ephemeral)
if [[ -d "$OPENCLAW" ]]; then
  mkdir -p "$STAGING/openclaw"
  rsync -a \
    --exclude '/logs/' \
    --exclude '/workspace/' \
    --exclude '/delivery-queue/' \
    --exclude '/completions/' \
    --exclude '*.log' \
    --exclude '*.sock' \
    "$OPENCLAW/" "$STAGING/openclaw/"
  echo "✓ openclaw (incl. secrets/, credentials/, identity/, agents/bni-masta/)"
fi

# 3. Cloudflared tunnel (config + credentials)
if [[ -d "$CLOUDFLARED" ]]; then
  mkdir -p "$STAGING/cloudflared"
  rsync -a "$CLOUDFLARED/" "$STAGING/cloudflared/"
  echo "✓ cloudflared"
fi

# 4. BNI-related LaunchAgents + the tunnel one
mkdir -p "$STAGING/LaunchAgents"
shopt -s nullglob
for plist in "$LAUNCHAGENTS"/ai.bnimasta.*.plist "$LAUNCHAGENTS"/com.cloudflare.bni-webhook-tunnel.plist; do
  [[ -f "$plist" ]] && cp "$plist" "$STAGING/LaunchAgents/"
done
shopt -u nullglob
echo "✓ LaunchAgents ($(ls "$STAGING/LaunchAgents" | wc -l | tr -d ' ') files)"

# 5. Runtime state snapshot (for restore-sanity-check later)
{
  echo "# BNI-Masta backup manifest"
  echo "timestamp: $(date -u +%FT%TZ)"
  echo "host: $(hostname)"
  echo "user: $(id -un)"
  echo
  echo "## launchctl services (bnimasta + cloudflare)"
  launchctl list 2>/dev/null | grep -E 'bnimasta|cloudflare' || echo "(none loaded)"
  echo
  echo "## crontab"
  crontab -l 2>/dev/null || echo "(no crontab)"
  echo
  echo "## staged sizes"
  du -sh "$STAGING"/* 2>/dev/null
  echo
  echo "## source paths"
  echo "vault:        $VAULT"
  echo "openclaw:     $OPENCLAW"
  echo "cloudflared:  $CLOUDFLARED"
  echo "launchagents: $LAUNCHAGENTS"
} > "$STAGING/MANIFEST.txt"

# 6. Tarball — .tmp then atomic move so partial files never linger
ARCHIVE="$BACKUP_DIR/bni-masta-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE.tmp" -C "$STAGING" .
mv "$ARCHIVE.tmp" "$ARCHIVE"
chmod 600 "$ARCHIVE"  # contains secrets + PII
echo "✓ wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# 7. Retention — delete backups older than $RETENTION_DAYS days
deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'bni-masta-*.tar.gz' -mtime +$RETENTION_DAYS -print -delete | wc -l | tr -d ' ')
[[ "$deleted" -gt 0 ]] && echo "✓ pruned $deleted old backup(s) (>${RETENTION_DAYS}d)"

echo "=== backup done $(date -u +%FT%TZ) ==="
echo
