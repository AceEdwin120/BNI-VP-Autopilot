#!/usr/bin/env bash
# install-wsl.sh — 在 WSL2 (Ubuntu 22.04) 內安裝 BNI-Masta 全部依賴並設定服務
#
# 在 WSL2 Ubuntu 終端機內執行：
#   cd /mnt/c/Users/User/OneDrive/Desktop/Claude\ Zoom/AI程式碼/BNI-VP-Autopilot
#   bash scripts/install-wsl.sh
#
# 前提：
#   - 已完成 setup-wsl.ps1（WSL2 + Ubuntu 22.04 已安裝）
#   - 已設定 Linux 使用者名稱與密碼

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VAULT_WIN="C:/Users/User/Documents/BNI AGENT/BNI AGENT"
VAULT_WSL="/mnt/c/Users/User/Documents/BNI AGENT/BNI AGENT"
SECRETS="$HOME/.openclaw/secrets/bni-masta.env"
AGENT_DIR="$HOME/.openclaw/agents/bni-masta"
SYSTEMD_USER="$HOME/.config/systemd/user"

echo "=== BNI-Masta WSL2 安裝腳本 ==="
echo "Repo: $REPO"
echo "Vault (WSL): $VAULT_WSL"
echo ""

# ── Step 1：啟用 WSL2 systemd ──────────────────────────────────────────────
echo "── Step 1：確認 systemd 已啟用 ──"
if ! systemctl --user status > /dev/null 2>&1; then
    echo "  設定 /etc/wsl.conf 啟用 systemd..."
    sudo tee /etc/wsl.conf > /dev/null <<'EOF'
[boot]
systemd=true
EOF
    echo "  ✓ 已寫入 /etc/wsl.conf"
    echo "  ⚠ 請重新啟動 WSL2：在 Windows PowerShell 執行 wsl --shutdown 後重開 Ubuntu"
    echo "    重啟後再次執行此腳本繼續安裝"
    exit 0
fi
echo "  ✓ systemd 正常運作"

# ── Step 2：安裝 Homebrew for Linux ──────────────────────────────────────
echo ""
echo "── Step 2：安裝 Homebrew for Linux ──"
if ! command -v brew > /dev/null 2>&1; then
    echo "  安裝 Homebrew（需要約 5–10 分鐘）..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # 加入 PATH
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> "$HOME/.bashrc"
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    echo "  ✓ Homebrew 安裝完成"
else
    eval "$(brew shellenv 2>/dev/null || /home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    echo "  · Homebrew 已安裝"
fi

# ── Step 3：安裝依賴套件 ──────────────────────────────────────────────────
echo ""
echo "── Step 3：安裝依賴套件（brew）──"
brew install --quiet \
    cloudflared node python jq \
    poppler ffmpeg uv gh
echo "  ✓ brew 套件安裝完成"

echo ""
echo "── Step 3b：安裝 OpenClaw（npm，跨平台版本）──"
npm install -g openclaw@latest --silent
echo "  ✓ OpenClaw 安裝完成"

# ── Step 4：安裝 Python 工具 ──────────────────────────────────────────────
echo ""
echo "── Step 4：安裝 nano-pdf（Python 工具）──"
uv tool install nano-pdf 2>/dev/null || echo "  · nano-pdf 已安裝或略過"
echo "  ✓ 完成"

# ── Step 5：建立 secrets 檔案 ────────────────────────────────────────────
echo ""
echo "── Step 5：建立 secrets 檔案 ──"
mkdir -p "$(dirname "$SECRETS")"
if [[ ! -f "$SECRETS" ]]; then
    cp "$REPO/.env.example" "$SECRETS"
    chmod 600 "$SECRETS"
    echo "  ✓ 已複製 .env.example → $SECRETS"
    echo "  ⚠ 請編輯 $SECRETS 填入你的 API 金鑰："
    echo "     nano $SECRETS"
else
    echo "  · secrets 檔案已存在，略過"
fi

# ── Step 6：注入 vault 路徑並複製 agent 檔案 ─────────────────────────────
echo ""
echo "── Step 6：注入 vault 路徑並複製 agent 檔案 ──"
mkdir -p "$AGENT_DIR"
python3 "$REPO/scripts/fix-paths.py" \
    --vault "$VAULT_WSL" \
    --agent-dir "$AGENT_DIR" \
    --repo "$REPO"
echo "  ✓ 完成"

# ── Step 7：安裝 Node.js 套件（services/）────────────────────────────────
echo ""
echo "── Step 7：安裝 Node.js 套件 ──"
cd "$AGENT_DIR/services" && npm install --silent 2>/dev/null || true
echo "  ✓ 完成"

# ── Step 8：設定 OpenClaw ────────────────────────────────────────────────
echo ""
echo "── Step 8：設定 OpenClaw ──"
if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
    echo "  執行 openclaw onboard..."
    openclaw onboard --auth-choice openai-codex || true
fi

# 載入 secrets 以供 render-openclaw-config.py 使用
set -a; source "$SECRETS" 2>/dev/null || true; set +a

echo "  渲染 openclaw.json 設定..."
python3 "$REPO/scripts/render-openclaw-config.py" \
    "$REPO/openclaw/openclaw.json.template" \
    "$HOME/.openclaw/openclaw.json" || true
echo "  ✓ 完成（請確認 $HOME/.openclaw/openclaw.json 中的 placeholder 都已填入）"

# ── Step 9：安裝 systemd 服務（取代 LaunchAgents）───────────────────────
echo ""
echo "── Step 9：安裝 systemd 服務 ──"
mkdir -p "$SYSTEMD_USER"

# 複製服務檔案
cp "$REPO/scripts/systemd/recall-webhook.service"   "$SYSTEMD_USER/"
cp "$REPO/scripts/systemd/cloudflared-bni.service"  "$SYSTEMD_USER/"
cp "$REPO/scripts/systemd/meeting-poll.service"     "$SYSTEMD_USER/"
cp "$REPO/scripts/systemd/meeting-poll.timer"       "$SYSTEMD_USER/"

systemctl --user daemon-reload
systemctl --user enable recall-webhook.service
systemctl --user enable cloudflared-bni.service
systemctl --user enable meeting-poll.timer

echo "  ✓ 服務已設定（recall-webhook、cloudflared-bni、meeting-poll）"
echo "  ⚠ cloudflared 需先設定 Tunnel 才能啟動（Step 10）"

# ── Step 10：Cloudflare Tunnel 提示 ─────────────────────────────────────
echo ""
echo "── Step 10：Cloudflare Tunnel（手動）──"
echo "  1. cloudflared tunnel login"
echo "  2. cloudflared tunnel create bni-webhook"
echo "  3. cloudflared tunnel route dns bni-webhook <你的子網域>.<你的網域>"
echo "  4. 更新 $SECRETS 的 RECALL_WEBHOOK_URL"
echo "  5. 更新 ~/.cloudflared/config-bni.yml（參考 scripts/cloudflared-config-bni.yml）"
echo "  6. 啟動服務：systemctl --user start cloudflared-bni recall-webhook"

# ── Step 11：Smoke test ──────────────────────────────────────────────────
echo ""
echo "── Step 11：冒煙測試（在 secrets 填好後執行）──"
echo "  source $SECRETS"
echo "  curl -s \"https://api.telegram.org/bot\${BNI_BOT_TOKEN}/getMe\" | jq .result.username"
echo "  openclaw channels status --probe"
echo ""
echo "=== 安裝腳本執行完畢 ==="
echo "下一步：填入 $SECRETS 的 API 金鑰，然後執行 Cloudflare Tunnel 設定"
