# BNI-Masta Architecture

## Big picture

```
                              ┌───────────────────────────┐
                              │    OBSIDIAN VAULT         │
                              │  ~/Documents/BNI AGENT/   │
                              │                           │
                              │  raw/   (immutable)       │
                              │  wiki/  (LLM-compiled)    │
                              └─────────▲──────▲──────────┘
                                        │      │
                      read                    │ write
                                        │      │ (single writer)
┌────────────┐   Telegram  ┌─────────┐  │      │   ┌────────────┐
│            │────────────▶│OpenClaw │──┤      └───│ Claude CLI │
│ Operator  │             │ gateway │  │          │(compiler)  │
│            │◀────────────│  :18801 │  │          └────────────┘
└────────────┘   LINE      └────┬────┘  │                ▲
                                │       │                │
                            agent routes│                │
                            bni-masta   │                │ spawned by
                            (GPT-5.4)   │                │ ingest-claude
                                        │                │
                                        ▼                │
                              ┌─────────────────┐        │
                              │ skills (6 v1)   ├────────┘
                              │                 │
                              │ pdf-ingest      │──▶ pdftotext
                              │ ingest-claude   │──▶ claude --print
                              │ member-upsert   │──▶ append raw/inbox/
                              │ transcribe-audio│──▶ OpenRouter Gemini
                              │ zoom-join       │──▶ Vexa API
                              │ resolve-attend  │──▶ fuzzy-match roster
                              └─────────────────┘
                                        ▲
                                        │
                                        │
                    ┌───────────────────┴─────────────┐
                    │ vexa-webhook.mjs LaunchAgent  │
                    │ :18821 loopback                 │
                    └───────────────────▲─────────────┘
                                        │
                              cloudflared tunnel
                                        │
                  https://<your-webhook-host>
                                        ▲
                                        │
                                   Vexa
                                        ▲
                                        │
                              joins as participant "BNI-Masta"
                                        ▲
                                        │
                                   Zoom meeting
```

## Two-brain split — why

- **Chat on GPT-5.4** (via Codex OAuth): free under ChatGPT subscription, fast, good tool-orchestration. We DO NOT pay per token.
- **Wiki compile on Claude**: best at long-context structured writing, careful cross-linking, handling Traditional Chinese + English mix. Pay-per-token (Anthropic API) but infrequent.
- Keeping them separate means: chat loop stays snappy; expensive structured-writing only fires when `raw/` gets new content.

## Storage — Karpathy LLM Wiki pattern

```
raw/      ← immutable. LLM never edits. Only appends.
wiki/     ← LLM rewrites. One markdown page per entity/topic.
          ← cross-linked via [[type/<name>]].
          ← wiki/index.md is the entrypoint for cold reads.
          ← wiki/log.md is append-only ingestion history.
```

No vector store. No RAG. The wiki *is* the index. LLM reads `wiki/index.md` first, then drills into specific pages.

## Data flows

### 1. The operator DMs bot a PDF (the 領導團隊手冊)
```
Telegram ──PDF──▶ OpenClaw ──▶ bni-masta agent
                                  │
                                  ▼ pdf-ingest skill
                            pdftotext chunks @ 20 pages/file
                                  │
                                  ▼ raw/handbooks/<slug>/page_NNN-NNN.md
                                  │
                                  ▼ auto-chain ingest-claude
                            Claude reads raw/, writes wiki/rules/*.md
                                  │
                                  ▼ appends wiki/log.md, updates wiki/index.md
Telegram ◀── confirmation ────────┘
```

### 2. Operator sends /zoom-join
```
Telegram ──/zoom-join URL pwd──▶ bni-masta
                                    │
                                    ▼ zoom-join skill
                              POST Vexa /api/v2/bot/
                              {bot_name: "BNI-Masta", webhook_url: https://bni-webhook…}
                                    │
                                    ▼ saves raw/meetings/<date>/<bot_id>.bot.json
                                    │
Vexa bot joins Zoom  ──▶ during meeting:
                              bot.status_change events
                              participant_join / leave / rename / speech
                                    │
                                    ▼ HTTPS → <your-webhook-host>
                                    ▼ cloudflared tunnel
                                    ▼ vexa-webhook.mjs (:18821)
                              appends raw/meetings/<date>/participants.jsonl
                                    │
Meeting ends ──bot.done──▶         ▼ auto-chain:
                              resolve-attendance.mjs
                                • load wiki/members/ roster (aliases)
                                • aggregate participants
                                • 3-tier match (exact → Levenshtein ≥85 → claude LLM)
                                • classify 準時/遲到/缺席/早退/全程/代理/來賓
                                • write raw/roll_calls/<date>.md
                                    │
                                    ▼ auto-chain ingest-claude
                              Claude compiles → wiki/meetings/<date>.md
                              with attendance table + minutes + action items
```

### 3. Operator asks a rule question
```
Telegram ──"副主席的暖身期是多久?"──▶ bni-masta
                                          │
                                          ▼ obsidian skill (read vault)
                                     reads wiki/index.md
                                          │
                                          ▼ follows link to wiki/rules/副主席職責.md
                                          ▼ returns citation + summary
Telegram ◀── answer + [[rules/副主席職責]] ──┘
```

## Ports + processes

| Port | Process | LaunchAgent |
|---|---|---|
| 18801 | OpenClaw gateway | `ai.openclaw.gateway.plist` (system's) |
| 18821 | vexa-webhook.mjs | `ai.bnimasta.vexa-webhook.plist` |
| (out) | cloudflared → :18821 | `com.cloudflare.bni-webhook-tunnel.plist` |
