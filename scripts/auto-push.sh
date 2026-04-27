#!/usr/bin/env bash
# BNI-Masta auto-push — sync live agent state into the GitHub-tracked repo
# and push to main nightly. Runs daily at 02:30 via ai.bnimasta.auto-push.
#
# What it syncs:
#   live ~/.openclaw/agents/bni-masta/agent/{SOUL.md,skills/}  → repo openclaw/agents/bni-masta/
#   live ~/.openclaw/agents/bni-masta/services/{lib/,*.mjs,package.json} → repo services/
#   live ~/Documents/BNI AGENT/BNI AGENT/{CLAUDE,AGENTS,_templates,_dashboards,wiki/{rules,index,log}.md,...} → repo vault/
#
# What it NEVER syncs (per repo .gitignore):
#   - Any *.log / .stderr.log / .stdout.log
#   - secrets/, auth-profiles/, *.env, credentials/
#   - vault/raw/ (immutable + visitor PII)
#   - vault/wiki/{members,meetings,chapters,events,reports,meeting_reports}/ (PII / per-meeting state)
#   - Cloudflared credentials, .obsidian workspace cache
#
# Idempotent: if nothing changed, no commit, no push.
# Safe: only operates on the main checkout (never on .claude/worktrees/*).

set -euo pipefail

REPO="$HOME/Documents/Claude/Projects/BNI-VP-Autopilot"
LIVE_AGENT="$HOME/.openclaw/agents/bni-masta/agent"
LIVE_SERVICES="$HOME/.openclaw/agents/bni-masta/services"
LIVE_SCRIPTS="$HOME/.openclaw/agents/bni-masta/scripts"
LIVE_VAULT="$HOME/Documents/BNI AGENT/BNI AGENT"
LOG_DIR="$HOME/.openclaw/agents/bni-masta/scripts"
LOG="$LOG_DIR/auto-push.log"

mkdir -p "$LOG_DIR"
exec >>"$LOG" 2>&1

echo "=== auto-push started $(date -u +%FT%TZ) ==="

cd "$REPO"

# Refuse to operate on a worktree (we want main checkout only)
if git rev-parse --git-dir 2>/dev/null | grep -q "worktrees"; then
  echo "✗ refusing to run inside a worktree — exiting"
  exit 0
fi

# Push target — dedicated branch so we never overwrite hand-curated history on main.
# Each night: hard-reset auto-sync to current main + apply live state + force-push.
# The operator can review/merge auto-sync → main at his discretion.
SYNC_BRANCH="auto-sync"

# Get on main + fast-forward (we use main as the *base* for the sync branch)
git fetch --quiet origin main || { echo "✗ fetch failed"; exit 1; }
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "ℹ on branch $CURRENT_BRANCH, switching to main"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "✗ uncommitted local changes — skipping (resolve manually)"
    exit 0
  fi
  git checkout main || { echo "✗ checkout main failed"; exit 0; }
fi
git pull --ff-only --quiet origin main || { echo "✗ pull --ff-only failed (local diverged); skipping"; exit 0; }

# Refuse if there are uncommitted local edits (don't clobber in-progress work)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ uncommitted local changes present — skipping (resolve manually, then re-run)"
  exit 0
fi

# Switch to sync branch (or create it from main)
if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  git checkout -q "$SYNC_BRANCH"
  git reset --hard --quiet main
else
  git checkout -q -b "$SYNC_BRANCH"
fi

# 1. SOUL + skills + agent config-ish files (NOT auth-profiles.json which has tokens)
mkdir -p openclaw/agents/bni-masta
rsync -a --delete \
  --exclude='auth-profiles.json' \
  --exclude='models.json' \
  --exclude='*.log' \
  --exclude='*.stderr.log' \
  --exclude='*.stdout.log' \
  --exclude='node_modules/' \
  --include='SOUL.md' \
  --include='skills/' \
  --include='skills/**' \
  --include='config/' \
  --include='config/**' \
  --exclude='*' \
  "$LIVE_AGENT/" openclaw/agents/bni-masta/

# 2. services/ — vexa-webhook + assets-server + lib + package.json
mkdir -p services
rsync -a --delete \
  --exclude='*.log' \
  --exclude='*.stderr.log' \
  --exclude='*.stdout.log' \
  --exclude='node_modules/' \
  --include='*.mjs' \
  --include='package.json' \
  --include='lib/' \
  --include='lib/**' \
  --exclude='*' \
  "$LIVE_SERVICES/" services/

# 3. scripts/ — backup.sh + auto-push.sh themselves
mkdir -p scripts
rsync -a \
  --exclude='*.log' \
  --include='*.sh' \
  --exclude='*' \
  "$LIVE_SCRIPTS/" scripts/

# 4. Vault — only safe-to-publish docs (rules, top-level docs, templates).
# NEVER sync raw/, members/, meetings/, chapters/, events/, reports/, meeting_reports/.
mkdir -p vault
rsync -a --delete \
  --exclude='raw/' \
  --exclude='wiki/members/' \
  --exclude='wiki/meetings/' \
  --exclude='wiki/chapters/' \
  --exclude='wiki/events/' \
  --exclude='wiki/reports/' \
  --exclude='wiki/meeting_reports/' \
  --exclude='.obsidian/workspace*.json' \
  --exclude='.obsidian/cache' \
  --exclude='.obsidian/cache/' \
  --exclude='.DS_Store' \
  --exclude='*.tmp' \
  "$LIVE_VAULT/" vault/

# 5. LaunchAgent plists (so they're versioned alongside the scripts they invoke)
mkdir -p ops/LaunchAgents
shopt -s nullglob
for plist in "$HOME/Library/LaunchAgents"/ai.bnimasta.*.plist "$HOME/Library/LaunchAgents"/com.cloudflare.bni-webhook-tunnel.plist; do
  [[ -f "$plist" ]] && cp "$plist" ops/LaunchAgents/
done
shopt -u nullglob

# Stage + commit if anything changed
git add -A
if git diff --cached --quiet; then
  echo "✓ no changes to push"
  exit 0
fi

CHANGED_FILES="$(git diff --cached --name-only | head -20 | sed 's/^/  - /')"
COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"

git commit -m "auto-push: nightly sync $(date -u +%F)

Synced live agent state to ${SYNC_BRANCH}. ${COUNT} file(s) changed:

${CHANGED_FILES}

Run by ai.bnimasta.auto-push LaunchAgent at 02:30 local.
Review and merge to main at your discretion."

# Force-push because the branch gets reset to main + applied live state each night.
# That's safe: this branch is owned by the auto-push job, never hand-curated.
git push --force-with-lease origin "$SYNC_BRANCH" && echo "✓ pushed ${COUNT} file change(s) to ${SYNC_BRANCH}"
echo "=== auto-push finished $(date -u +%FT%TZ) ==="

# Return to main so subsequent shells / tools see the expected branch
git checkout -q main || true
