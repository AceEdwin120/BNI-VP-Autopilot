#!/usr/bin/env bash
# BNI-Masta install — replays the full setup on a fresh Mac.
# Prerequisite: ~/.openclaw/secrets/bni-masta.env already filled out.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="$HOME/Documents/BNI AGENT/BNI AGENT"
SECRETS="$HOME/.openclaw/secrets/bni-masta.env"
AGENT_DIR="$HOME/.openclaw/agents/bni-masta"

[[ -f "$SECRETS" ]] || { echo "✗ $SECRETS missing. Copy .env.example there first."; exit 1; }
set -a; source "$SECRETS"; set +a

echo "=== 1. Homebrew deps ==="
brew install --quiet \
  node python openclaw cloudflared poppler ffmpeg jq \
  ocrmypdf tesseract-lang gh uv \
  yakitrak/yakitrak/obsidian-cli steipete/tap/gogcli

echo "=== 2. uv tool install nano-pdf ==="
uv tool install nano-pdf || true

echo "=== 3. openclaw onboard (if needed) ==="
if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
  openclaw onboard --auth-choice openai-codex
fi

echo "=== 4. Codex OAuth (browser) ==="
openclaw models list --provider openai-codex | grep -q gpt-5.4 || \
  openclaw models auth login --provider openai-codex

echo "=== 5. Seed agent dir ==="
mkdir -p "$AGENT_DIR/agent/skills" "$AGENT_DIR/services"
cp -R "$REPO/openclaw/agents/bni-masta/skills/"* "$AGENT_DIR/agent/skills/"
cp "$REPO/openclaw/agents/bni-masta/SOUL.md" "$AGENT_DIR/agent/"
cp "$REPO/services/vexa-webhook.mjs" "$AGENT_DIR/services/"
cp "$REPO/services/package.json" "$AGENT_DIR/services/"
chmod +x "$AGENT_DIR/agent/skills/"*/*.{mjs,sh} 2>/dev/null || true

echo "=== 6. Seed vault (merge, don't overwrite raw/ or wiki/members/) ==="
mkdir -p "$VAULT"
[[ -f "$VAULT/CLAUDE.md" ]] || cp "$REPO/vault/CLAUDE.md" "$VAULT/"
[[ -f "$VAULT/AGENTS.md" ]] || cp "$REPO/vault/AGENTS.md" "$VAULT/"
mkdir -p "$VAULT/_templates" "$VAULT/_dashboards"
cp -n "$REPO/vault/_templates/"* "$VAULT/_templates/" 2>/dev/null || true
cp -n "$REPO/vault/_dashboards/"* "$VAULT/_dashboards/" 2>/dev/null || true
mkdir -p "$VAULT/wiki/rules" "$VAULT/raw/handbooks" "$VAULT/raw/transcripts" "$VAULT/raw/roll_calls" "$VAULT/raw/meetings" "$VAULT/raw/visitors" "$VAULT/raw/inbox"
cp -n "$REPO/vault/wiki/rules/"*.md "$VAULT/wiki/rules/" 2>/dev/null || true
[[ -f "$VAULT/wiki/index.md" ]] || cp "$REPO/vault/wiki/index.md" "$VAULT/wiki/"
[[ -f "$VAULT/wiki/log.md" ]] || echo -e "# 變更紀錄 (Ingestion Log)\n\n---\n" > "$VAULT/wiki/log.md"

echo "=== 7. Patch openclaw.json ==="
if [[ ! -f "$HOME/.openclaw/openclaw.json.template-applied" ]]; then
  cp "$HOME/.openclaw/openclaw.json" "$HOME/.openclaw/openclaw.json.pre-install-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  python3 "$REPO/scripts/render-openclaw-config.py" \
    "$REPO/openclaw/openclaw.json.template" \
    "$HOME/.openclaw/openclaw.json"
  touch "$HOME/.openclaw/openclaw.json.template-applied"
fi

echo "=== 8. LaunchAgents ==="
install -m 0644 "$REPO/scripts/launchagents/ai.bnimasta.vexa-webhook.plist" \
  "$HOME/Library/LaunchAgents/ai.bnimasta.vexa-webhook.plist"
install -m 0644 "$REPO/scripts/launchagents/com.cloudflare.bni-webhook-tunnel.plist" \
  "$HOME/Library/LaunchAgents/com.cloudflare.bni-webhook-tunnel.plist"
launchctl unload "$HOME/Library/LaunchAgents/ai.bnimasta.vexa-webhook.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.cloudflare.bni-webhook-tunnel.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/ai.bnimasta.vexa-webhook.plist"
launchctl load "$HOME/Library/LaunchAgents/com.cloudflare.bni-webhook-tunnel.plist"

echo "=== 9. Restart gateway ==="
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" || true

echo "=== 10. Smoke test ==="
sleep 4
curl -s "https://api.telegram.org/bot${BNI_BOT_TOKEN}/getMe" | jq -r '.result.username // "UNKNOWN"'
curl -s -o /dev/null -w "webhook: %{http_code}\n" --max-time 10 -X POST "$VEXA_WEBHOOK_URL" -H "content-type: application/json" -d '{"event":"ping"}'
openclaw channels status --probe 2>&1 | tail -10

echo "✔ install complete. Manual next steps:"
echo "   - cloudflared tunnel login (if not done)"
echo "   - gog auth credentials / gog auth add (Google OAuth)"
echo "   - BotFather: /newbot if you need a fresh BNI-Masta bot"
echo "   - Open Obsidian vault + enable community plugins (see OBSIDIAN-SETUP.md)"
