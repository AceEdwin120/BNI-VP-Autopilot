#!/usr/bin/env bash
# ingest-claude — invoke Claude CLI in the BNI vault to compile raw/ → wiki/
#
# Usage: compile.sh [scope] [note]
#   scope: optional path under raw/ to limit the pass (default: raw/)
#   note:  optional extra context string

set -euo pipefail

VAULT="<vault-path>"
SCOPE="${1:-raw/}"
NOTE="${2:-}"

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI not found on PATH. Install: https://docs.claude.com/en/docs/claude-code" >&2
  exit 2
fi

cd "$VAULT"

PROMPT="You are the wiki compiler for BNI-Masta. Read CLAUDE.md for the schema. \
Read wiki/log.md to find the last ingestion time. \
Walk ${SCOPE} for files newer than that time. For each new source file: \
(1) read it, (2) identify which wiki/ pages it touches (members/, meetings/, rules/, etc.), \
(3) read each of those wiki pages first, then update them following the front-matter \
contracts in CLAUDE.md, (4) update wiki/index.md if new pages were created, \
(5) append one summary line to wiki/log.md. \
Cross-link every member mention as [[members/<name>]], every chapter as [[chapters/<name>]], \
every rule as [[rules/<topic>]]. Never modify raw/. Never invent facts not in raw/. \
Current time: $(date '+%Y-%m-%d %H:%M %Z'). ${NOTE:+Extra note: ${NOTE}}"

echo "→ compiling ${SCOPE} in ${VAULT}"
claude --print --permission-mode acceptEdits "$PROMPT"
