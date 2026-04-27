---
name: ingest-claude
description: Invokes the Claude CLI in the BNI vault to compile any new raw/ files into wiki/ pages per the Karpathy LLM-Wiki pattern. This is the "wiki compiler brain" in the two-brain architecture.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: [claude]
    triggers:
      - "/ingest-claude"
      - "auto-chained after pdf-ingest, transcribe-audio, resolve-attendance, member-upsert"
---

# ingest-claude

**Role:** the wiki compiler brain. Shell out to Claude in the vault directory with a compile prompt. Claude reads `CLAUDE.md` for the schema, walks `raw/` for files newer than `wiki/log.md`'s last entry, and rewrites the relevant `wiki/` pages.

## Inputs

- `scope` (optional) — a path under `raw/` to restrict the pass. Default: whole `raw/`.
- `note` (optional) — extra context to pass Claude (e.g., "treat this meeting as a 封閉會議").

## Behavior

1. `cd <your-vault-path>`
2. Run `claude --print` with a prompt that says:
   - Read `CLAUDE.md` for the wiki schema
   - Read `wiki/log.md` to find the last ingestion time
   - Walk `raw/` (or `scope`) for newer files
   - For each, update matching `wiki/` pages, update `wiki/index.md`, append a line to `wiki/log.md`
3. Stream Claude's output back to the Telegram user (or log it if invoked non-interactively).

## Implementation

Script: `./compile.sh`. Run via `bash compile.sh [scope] [note]`.

## Why a separate skill / separate brain?

- Keeps Telegram chat on cheap GPT-5.4 (Codex OAuth, free under ChatGPT sub).
- Keeps wiki compilation on Claude, which is better at long-context structured writing and cross-linking.
- Isolates cost: the expensive model only runs when new raw content appears.

## Cost expectation

~$0.30–$1.50 per ingestion run depending on how many new raw files. The 466-page handbook ingestion is the biggest one-off (expect ~$3–$6 one-time).
