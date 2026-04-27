# BNI-Masta — Framework Documentation Prompt

> Source-of-truth specification for generating visual, end-to-end documentation
> of the BNI-Masta personal-assistant framework. Feed this entire file to
> Claude (or any design-capable model) to produce a beautifully-laid-out
> architecture document.

---

## INSTRUCTIONS TO THE READING MODEL (visual documentation generator)

You are receiving a complete technical specification of **BNI-Masta**, a personal
AI assistant operated by the operator (副主席 / Vice President of the <YourChapter> BNI chapter
in Taiwan). Your task is to produce a polished, visual documentation page —
intended for a *non-technical reader* — that captures every section below.

Required output sections (in this order):

1. **Hero section** — one-sentence elevator pitch + the bot's lion mascot 🦁
2. **Concept & aim** — what BNI-Masta is, who it serves, what problem it solves
3. **Two-brain architecture** — visual diagram showing GPT chat brain ↔ Claude wiki compiler
4. **System overview diagram** — Mermaid (graph LR) covering: channels → gateway → skills → vault → external services. Use icons for Telegram / LINE / Zoom / Google Sheets / Anthropic / OpenAI / OpenRouter / Vexa
5. **Pipeline walkthroughs** — three numbered flows with sequence diagrams:
   - **Pipeline A:** Document ingest (operator sends a PDF / audio note)
   - **Pipeline B:** Live meeting (bot joins Zoom → records → post-meeting chain)
   - **Pipeline C:** In-meeting chat reply (someone @-mentions the bot)
6. **Skill catalog** — card grid, one card per skill, with: name · trigger · what it does · what it writes
7. **Runtime services** — table of LaunchAgents with schedules
8. **Vault data model** — YAML front-matter schemas for member / meeting / rule
9. **External integrations** — matrix (provider × purpose × cost-model × auth)
10. **Cost model** — monthly $ breakdown
11. **Backup + GitHub sync** — flow diagram
12. **Future roadmap** — what's coming in v2

Style guidance:
- Use Mermaid for all diagrams (the model that will render this supports Mermaid)
- Keep code blocks small; explanations in prose
- Use callouts (`> [!note]`, `> [!warning]`) for invariants and gotchas
- Color-code or icon-tag sections by domain (chat / vault / external / runtime)
- Where there's a decision rule (e.g. Friday-only digest), make it stand out
- Avoid Anthropic / OpenAI brand promotion — this is the operator's tool, not a vendor pitch

---

## SOURCE CONTENT FOR DOCUMENTATION

### Concept

**BNI-Masta** (named after the original creator + Bot + Master) is a personal AI assistant for one specific
person (the original operator) in their role as Vice President (副主席) of the <YourChapter> chapter
of BNI Taiwan (Business Network International, a global referral-marketing
organization). It runs entirely on the operator's Mac, accepts commands from Telegram
and LINE, attends Zoom meetings as an autonomous participant, maintains a
structured knowledge base in Obsidian, and pushes attendance + member CRM
data to a Google Sheet shared with the chapter leadership.

The mascot is a 🦁 lion ("Masta" / "Master"). The bot's full Zoom display name
is `BNI Masta(<YourName>副主席習ＡＩ助理)` — literally "BNI Master, Vice President <YourName>'s
AI assistant".

### Aim

Five concrete outcomes:

1. **Eliminate manual roll-call.** After every Friday 例會 (regular meeting),
   PALMS attendance (P=present, L=late, A=absent, M=medical, S=substitute) is
   resolved automatically from Zoom participant events, fuzzy-matched against
   the 35-member roster, and pushed to the chapter's Google Sheet — within
   minutes of the meeting ending, with zero clicks.

2. **Replace the leadership handbook with a queryable knowledge base.** The
   official BNI 領導團隊手冊 (170-page Traditional Chinese PDF) is OCR'd via
   Gemini 2.5 Flash, chunked, then compiled into 22 cross-linked Obsidian
   pages covering every officer role, policy, and procedure. The operator queries it
   conversationally via Telegram or LINE.

3. **Capture every meeting permanently.** A Vexa bot joins each Zoom
   call as an actual participant, records audio + video, transcribes speech
   in real time (Recall's bundled `recallai_streaming`), normalizes
   simplified→Traditional Chinese, and produces a structured meeting report
   (agenda-aware: 例會 vs 封閉會議 / 接待組 / 導師團 / 會員委員會 / 領導團隊月會).

4. **Be helpful in real time during meetings.** When members type in Zoom
   chat, the bot welcomes them, nudges name-format compliance (`編號｜姓名｜
   專業`), recognizes ~150 cheer triggers (Chinese praise, 666/888 numerology,
   emoticons, English) and amplifies positive energy with a 60-quote BNI
   wisdom bank. When @-mentioned, it answers vault questions in <3s via
   Claude Haiku 4.5 (with a pre-computed Q&A cache hitting in <100ms for the
   most common questions).

5. **Brief the operator daily.** A Telegram digest fires after every Friday meeting
   summarizing attendance, action items, top-3 decisions, links to the
   Obsidian pages, and pipeline status (which post-meeting steps succeeded).

### The two-brain rule (CRITICAL invariant)

Two distinct LLMs do two distinct jobs. They never overlap.

| Brain | Model | Job | Hosting | Cost |
|---|---|---|---|---|
| **Chat brain** | Claude Haiku 4.5 (default) via OpenRouter; fallback GPT-5.4 via OpenAI Codex OAuth | Receives all human messages (Telegram, LINE, Zoom chat). Decides what skill to invoke. Returns short answers in user's language. | OpenRouter API call (HTTPS) | ~$0.18 / Friday meeting on Haiku |
| **Wiki compiler brain** | Claude (via the local `claude` CLI) | Reads `raw/` (immutable inputs), maintains `wiki/` (compiled cross-linked pages). Schema-driven — never invents facts. | Local CLI subprocess | Anthropic API (or Claude Code subscription quota) |

**Hard rule:** the chat brain MUST NOT write to `wiki/`. The wiki compiler MUST
NOT handle channel chat. They communicate only through the filesystem (`raw/`).

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  HUMAN-FACING LAYER                                                  │
│  • Telegram (<your-telegram-alert-bot>)                                          │
│  • LINE (BNI-Masta official account)                                  │
│  • Zoom chat (in-meeting, via Vexa bot)                         │
│  • Obsidian Sync (the operator reads/edits the vault on phone + 2 PCs)       │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│  GATEWAY LAYER                                                       │
│  ai.openclaw.gateway (LaunchAgent, port 18801)                       │
│  • Routes Telegram/LINE messages → "bni-masta" agent                 │
│  • Persona = SOUL.md, behavior = AGENTS.md                           │
│  • Skills auto-discovered from ~/.openclaw/agents/bni-masta/agent/skills/ │
│  • Authenticates: Codex OAuth (GPT-5.4) for legacy chat            │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│  SKILL LAYER (10 skills, all Node or Bash scripts)                   │
│  • zoom-join · pdf-ingest · transcribe-audio · member-upsert         │
│  • ingest-claude · resolve-attendance · meeting-report               │
│  • attendance-to-sheet · roster-sync · post-meeting-digest           │
│  • meeting-poll (LaunchAgent, every 60s — orchestrator)              │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│  STORAGE LAYER                                                       │
│  Obsidian vault @ ~/Documents/BNI AGENT/BNI AGENT/                   │
│  ├── raw/         (immutable, bot writes only)                       │
│  └── wiki/        (Claude-compiled, structured, cross-linked)        │
│  Google Sheet @ docs.google.com/.../<your-google-sheet-id> (3 tabs)               │
│  GitHub repo (public template, code + safe docs)             │
└──────────────────────────────────────────────────────────────────────┘
                                  ↑
┌──────────────────────────────────────────────────────────────────────┐
│  EXTERNAL EVENT LAYER                                                │
│  • Vexa realtime webhooks → cloudflared tunnel                  │
│    (<your-webhook-host> → 127.0.0.1:18821)                  │
│  • Lion-avatar HTML → ai.bnimasta.assets-server :18822 → tunnel      │
└──────────────────────────────────────────────────────────────────────┘
```

### Channel layer

**Telegram (`<your-telegram-alert-bot>`)** — primary daily driver. The operator's chat ID
`<your-telegram-chat-id>` is the only allowed sender (group `allowFrom` policy). Bot
streams partial messages back, supports voice notes (auto-transcribed) and
file uploads (auto-routed to `pdf-ingest` for `.pdf`, `transcribe-audio` for
`.mp3` / `.m4a` / `.wav` / `.ogg` / `.mp4`).

**LINE** — secondary channel for chapter members in Taiwan (LINE is dominant
there). Same agent, same skills, different transport. Channel secret +
access token in `~/.openclaw/secrets/bni-masta.env`.

**Zoom chat (in-meeting)** — driven by the Vexa bot. The bot does NOT
respond on stage 1 (out of meeting); it only acts inside live meetings via
the vexa-webhook → meeting-handlers pipeline. See Pipeline C below.

### Storage layer

**Obsidian vault** at `~/Documents/BNI AGENT/BNI AGENT/`.

```
BNI AGENT/
├── CLAUDE.md            ← schema + rules for the wiki compiler
├── AGENTS.md            ← skill catalog + routing rules for the chat brain
├── SOUL.md              ← chat brain's persona definition
├── _templates/          ← Obsidian Templater snippets
├── _dashboards/         ← Dataview-rendered status pages
│   ├── traffic_lights.md       (red/yellow/green per member)
│   ├── attendance.md           (recent meetings + lowest attendance)
│   └── follow_ups.md           (referrals + visitor follow-ups)
├── raw/                 ← IMMUTABLE — only skills append here
│   ├── handbooks/<slug>/         (OCR'd PDF chunks)
│   ├── transcripts/<file>.md     (voice note transcripts)
│   ├── meetings/<date>/          (per-meeting raw events)
│   │   ├── <bot_id>.bot.json              (Recall dispatch manifest)
│   │   ├── <bot_id>.participant_events.json
│   │   ├── <bot_id>.chat_state.json       (live in-meeting bot state)
│   │   ├── <bot_id>.done                  (post-meeting chain results)
│   │   ├── <bot_id>.digest_sent           (Telegram digest marker)
│   │   ├── participants.jsonl             (normalized event stream)
│   │   ├── transcript.jsonl               (per-utterance, 繁體 normalized)
│   │   ├── transcript.json                (Recall final dump)
│   │   ├── participants_list.json         (Recall authoritative roster)
│   │   ├── speaker_timeline.json
│   │   └── _times.json                    (start/end timestamps)
│   ├── roll_calls/<date>.md      (resolved attendance + visitors)
│   ├── visitors/<date>.jsonl     (unmatched display names)
│   └── inbox/                    (drop-zone for member-upsert + ad-hoc)
└── wiki/                ← Claude-maintained, never bot-written directly
    ├── index.md                (top-level navigation)
    ├── log.md                  (one line per compile pass)
    ├── members/<name>.md       (one per active BNI member; PII!)
    ├── meetings/<date>.md      (one per meeting; attendance + transcript snippets)
    ├── meeting_reports/<date>.md  (agenda-aware structured summary)
    ├── chapters/<name>.md      (chapter info; only one for now: <YourChapter>)
    └── rules/<topic>.md        (22 pages compiled from the leadership handbook)
```

**Google Sheet** at `docs.google.com/spreadsheets/d/<your-google-sheet-id>/edit`:

| Tab | Purpose | Updated by | When |
|---|---|---|---|
| `<YourChapter>會員名單` | Member roster (name, expertise, contact, joined date) | `roster-sync` skill | Sun 22:00 cron + after every meeting |
| `紅綠燈` | Traffic-light Power-of-One status per member | `roster-sync` | Same as above |
| `出席紀錄` | One column per meeting date, PALMS code per member | `attendance-to-sheet` | After every non-test Friday meeting |

### Skill catalog (10 skills)

Each skill is an executable script under `~/.openclaw/agents/bni-masta/agent/skills/<name>/`.
The chat brain invokes them by their canonical paths (documented in
`SOUL.md` skill cheat-sheet so GPT can find them).

| Skill | Trigger | Inputs | Effect |
|---|---|---|---|
| **zoom-join** | The operator pastes a Zoom link in Telegram | `<url> [pwd] [title]` | POSTs to Vexa `/api/v1/bot/`. Configures realtime webhooks for `participant_events.{join,leave,update,speech_on,speech_off,webcam_on,webcam_off,chat_message}` + `transcript.data`. Sets bot display name + lion video avatar (HTML page hosted by `ai.bnimasta.assets-server`). Saves manifest to `raw/meetings/<date>/<bot_id>.bot.json`. Auto-leave rules: 5 min alone, 15 min waiting room, 30 min silence, 1 min after everyone leaves, 3 hours hard cap. |
| **pdf-ingest** | `.pdf` upload | `<absolute_path>` | Auto-detects scanned PDFs. Primary OCR = **Gemini 2.5 Flash via OpenRouter** (5-page batches, 4-retry on 5xx/429), fallback to `ocrmypdf`. Writes `raw/handbooks/<slug>/chunk_NN.md`. Auto-chains `ingest-claude`. |
| **transcribe-audio** | `.mp3` / `.m4a` / `.wav` / `.ogg` / `.mp4` upload | `<absolute_path> [title]` | Posts audio to OpenRouter Gemini 2.5 Flash. Writes `raw/transcripts/<filename>.md`. Auto-ingest. |
| **member-upsert** | `Add 張大明, 商業保險, <YourChapter>` | `'<json>'` | Appends to `raw/inbox/members_<date>.jsonl`. The Claude wiki compiler picks it up on next `ingest-claude`. |
| **ingest-claude** | Auto after every other skill OR `/ingest-claude` | `[scope] [note]` | Shells out `claude --print --permission-mode acceptEdits` in the vault. Claude reads `raw/`, compares mtimes against `wiki/log.md`, updates the relevant `wiki/` pages following the schema in `vault/CLAUDE.md`. |
| **resolve-attendance** | Auto in meeting-poll chain | `<YYYY-MM-DD>` | 3-tier fuzzy match: exact name → Levenshtein ≤ 2 → Claude arbitration for the residue. Detects `代理人` keyword in display names → strips it, matches the cleaned name to the original member, classifies as `S` (代理人, 0.5 score). Writes `raw/roll_calls/<date>.md` with rich front-matter (expected/present/late/early_leave/substitute/absent/visitor counts + `late_arrivals[]`, `absent_members[]`, `visitors[]`, `substitutes[]` lists). 07:05 Friday hard cutoff for 遲到. Phantom-filter drops bot-self echo events. Outputs visitor list to `raw/visitors/<date>.jsonl`. |
| **meeting-report** | Auto in chain | `<YYYY-MM-DD>` | BNI-agenda-aware structured summary. Detects `例會` (20-item standard agenda) vs `封閉會議` (Claude picks subtype: 接待組 / 導師團 / 會員委員會 / 領導團隊月會). Skip rules: optional items quietly omit, mandatory items render with `> [!warning]` callout. Writes `wiki/meeting_reports/<date>.md` + side-effect `raw/inbox/referrals_<date>.jsonl` (extracts the 業務引薦 table for CRM feed). |
| **attendance-to-sheet** | Auto in chain | `<YYYY-MM-DD> [--force]` | Reads `raw/roll_calls/<date>.md`. Computes PALMS codes (P=1.0, L=0.5, A=0, M=excused, S=0.5). Writes new column to 出席紀錄 tab. Bumps each `wiki/members/<name>.md` front-matter (`attendance_pct`, `last_attendance_scores`, `_last_meeting_palms`, `updated`). **Skips if meeting is `test: true` / `excluded_from_scoring: true`.** Idempotent via marker file. |
| **roster-sync** | Sun 22:00 LaunchAgent + after every meeting (`--push-only` flag) | `[--push-only]` | Reads all `wiki/members/*.md`. Upserts into <YourChapter>會員名單 + 紅綠燈 tabs via the bundled `gog` CLI (Google API wrapper). |
| **post-meeting-digest** | Auto in chain (step 6) | `<YYYY-MM-DD> <bot_id> [--force]` | Builds a Telegram message: pipeline status icons (✓/✗/⏭ per skill), attendance counts, summary first-paragraph from meeting_report, top-3 action items, Obsidian + Sheet deep-links. POSTs to `<your-telegram-alert-bot>` chat `<your-telegram-chat-id>`. **Friday-only by default** (Mon-Thu / Sat-Sun runs self-skip with `{skipped:"not_friday"}` marker). Failure does NOT block the chain. |
| **post-meeting-line-digest** | Auto in chain (step 7, FINAL) | `<YYYY-MM-DD> <bot_id> [--force]` | Builds the BNI 副主席 standard 「每週會後公布夥伴出席狀況」 template using counts + lists from `raw/roll_calls/<date>.md` front-matter. Pushes to the operator's LINE via the Messaging API push endpoint (`LINE_CHANNEL_ACCESS_TOKEN` → `ALEX_LINE_ID = <your-line-user-id>`). Format: 應到/實到/代理/遲到/缺席/來賓 counts + per-bucket lists with `<編號><姓名>` formatting (編號 from `wiki/members/<name>.md::index`). **Friday-only**. Skips test meetings. Idempotent. |

### Runtime services (LaunchAgents)

All under `~/Library/LaunchAgents/`. KeepAlive when applicable.

| LaunchAgent | Schedule | Purpose | Port | Logs |
|---|---|---|---|---|
| `ai.openclaw.gateway` | Always-on | Main OpenClaw gateway | 18801 | `~/.openclaw/logs/gateway.{log,err.log}` |
| `ai.bnimasta.vexa-webhook` | Always-on | Receives Vexa realtime events; calls in-meeting handlers | 18821 | `~/.openclaw/agents/bni-masta/services/vexa-webhook.{stdout,stderr}.log` |
| `ai.bnimasta.assets-server` | Always-on | Serves the lion video-avatar HTML | 18822 | `~/.openclaw/agents/bni-masta/services/assets-server.{stdout,stderr}.log` |
| `com.cloudflare.bni-webhook-tunnel` | Always-on | Cloudflared named tunnel: `<your-webhook-host>` → 18821 (webhook) + `/assets/` → 18822 | — | `~/.cloudflared/bni-tunnel.{stdout,stderr}.log` |
| `ai.bnimasta.meeting-poll` | Every 60s | Detects bot.done, runs the post-meeting chain | — | `~/.openclaw/agents/bni-masta/agent/skills/meeting-poll/poll.{stdout,stderr}.log` |
| `ai.bnimasta.roster-sync` | Sunday 22:00 | Weekly full sync of vault → Google Sheet | — | LaunchAgent stdout only |
| `ai.bnimasta.backup` | Daily 03:00 | Local tarball of vault + openclaw + secrets + cloudflared + LaunchAgents → `~/Archive/BNI-Masta-Backups/` (30-day retention) | — | `~/.openclaw/agents/bni-masta/scripts/backup.log` |
| `ai.bnimasta.auto-push` | Daily 02:30 | Syncs live state into the GitHub repo's `auto-sync` branch (force-with-lease). Excludes secrets / member PII / raw / per-meeting state / logs. | — | `~/.openclaw/agents/bni-masta/scripts/auto-push.log` |

### External integrations

| Provider | Purpose | Auth | Cost model |
|---|---|---|---|
| **OpenRouter** | Chat brain (Claude Haiku 4.5) + Gemini 2.5 Flash for OCR + audio transcription | `OPENROUTER_API_KEY` env | $1/M in, $5/M out (Haiku); ~$0.07/M in (Gemini Flash). ~$1-3 / month total. |
| **OpenAI Codex (legacy)** | Fallback chat brain (GPT-5.4 via openclaw) | OAuth via ChatGPT Plus subscription | Free under subscription |
| **Anthropic API** | Wiki compiler (`claude` CLI invoked by `ingest-claude`) | `ANTHROPIC_API_KEY` env (or Claude Code subscription) | Per-token; usually <$1/month |
| **Vexa** | Zoom bot — joins, records, transcribes, fires realtime webhooks | `VEXA_API_KEY` env, region `ap-northeast-1` | ~$0.50/hour of meeting. Free tier covers initial testing. |
| **Google APIs** (Sheets, Calendar, Drive) | Read/write the chapter Sheet; Future: BNI Calendar | OAuth via the bundled `gog` CLI, account `<your-google-account>` | Free under personal quotas |
| **Cloudflare** | Named tunnel for the public webhook URL | Cloudflared OAuth, tunnel UUID stored locally | Free |
| **Telegram Bot API** | `<your-telegram-alert-bot>` send/receive | Bot token | Free |
| **LINE Messaging API** | Channel access | Channel secret + access token | Free |
| **Obsidian Sync** | Vault sync across devices (Mac + 2 PCs + iPhone), end-to-end encrypted | Obsidian account login | $10 / month |

### Pipelines

#### Pipeline A — Document ingest (PDF or audio)

```
The operator DMs <your-telegram-alert-bot> a file
  → openclaw gateway routes to bni-masta agent
  → chat brain detects file type, invokes pdf-ingest OR transcribe-audio
  → skill writes to raw/handbooks/ OR raw/transcripts/
  → auto-chains ingest-claude
  → claude CLI compiles raw/ → wiki/ (per CLAUDE.md schema)
  → wiki/log.md gets one new line
  → bot replies with phase summary
```

Latency: PDF ingest with OCR = 2-10 min depending on page count.
Audio: ~10-30 sec per minute of audio.

#### Pipeline B — Live meeting (the big one)

```
Operator pastes Zoom link in Telegram
  → chat brain invokes zoom-join
  → POST to Vexa (with avatar config + auto-leave rules + realtime webhooks)
  → bot.json saved to raw/meetings/<date>/<bot_id>.bot.json
  → chat brain replies "BNI-Masta bot dispatched"

  ⏬ Vexa bot joins Zoom

  → realtime webhooks fire to <your-webhook-host>
  → cloudflared forwards to localhost:18821
  → vexa-webhook.mjs writes participants.jsonl + transcript.jsonl
  → calls meeting-handlers.mjs:
      • on bot self-join: post intro (Friday 06:45-07:30 only) + sweep existing participants
      • on participant join: greet, name-check, rename nudge if not in 編號｜姓名｜專業 format
      • on chat_message: cheer detection ×150 OR @-mention LLM reply (qa-cache → Haiku)
      • Friday 07:05: post numbered roster announcement (idempotent)

  ⏬ Meeting ends, bot leaves (auto-leave timeout fires)

  → meeting-poll (every 60s) detects bot.done via Recall API
  → downloads transcript + participants_list + speaker_timeline + video_mixed_mp4 URL
  → runs the post-meeting chain (each step has 10-min timeout):
      1. resolve-attendance  → raw/roll_calls/<date>.md
      2. ingest-claude       → wiki/meetings/<date>.md + wiki/members/* updates
      3. meeting-report      → wiki/meeting_reports/<date>.md
      4. attendance-to-sheet → 出席紀錄 sheet column (skipped on test meetings)
      5. roster-sync         → <YourChapter>會員名單 + 紅綠燈 sheet tabs
      6. post-meeting-digest → Telegram message to operator (Friday-only)
      7. post-meeting-line-digest → LINE 副主席 standard attendance template (Friday-only)
  → writes <bot_id>.done with per-step success flags
```

#### Pipeline C — In-meeting chat reply

```
Member types in Zoom chat
  → Recall fires participant_events.chat_message webhook
  → cloudflared → vexa-webhook.mjs
  → digRecallData() extracts participant + text from evt.data.data.{participant,data:{text,to}}
  → handleChatMessage:
      • Discover participant (greet + name-check if first activity)
      • If text matches @-mention pattern (5 shapes covering BNI Masta / <YourChineseName> / bnimasta):
          1. tryCachedAnswer(text) — 11 patterns, <100ms hit
          2. miss → claude-responder.generateChatReply(text):
             POST to OpenRouter, model anthropic/claude-haiku-4.5
             prompt = SYSTEM_RULES_HEAD + buildVaultContext (~2KB cached) + SYSTEM_RULES_TAIL + user text
             ~2-3s reply, log [claude] reply OK (Nch, elapsed=Nms)
      • Elif text triggers cheer detector (150 patterns):
          pickQuote() from 60-quote bank, avoiding last 8
      • Else: silent
  → sendChatMessage POSTs to Vexa /send_chat_message/
  → updates state.freeFormResponseCount, state.lastReplyAt, state.recentQuotes
  → 50/meeting cap; 5s inter-reply cooldown
```

### Vault data model

Member YAML schema (`wiki/members/<name>.md`):

```yaml
type: member
name: <YourChineseName>
chapter: <YourChapter>
expertise: AI agent
joined: null                    # ISO date or null
status: active                  # active | departed | observation
traffic_light: null             # green | yellow | red | black | null
aliases: ["<YourEnglishAlias>"]               # name match fallbacks
telegram_id: null
phone: null
email: null
last_121: null                  # date of most recent 1-to-1
attendance_pct: null            # rolling 6-meeting avg × 100
last_attendance_scores: null    # [1.0, 0.5, 1.0, ...]
_last_meeting_palms: null       # P | L | A | M | S
referrals_given_6mo: 0
referrals_received_6mo: 0
visitors_brought_6mo: 0
ones_6mo: 0
ceu_count_6mo: 0
sponsoring_count_6mo: 0
created: 2026-04-22
updated: 2026-04-22
```

Meeting page schema (`wiki/meetings/<date>.md`):

```yaml
type: meeting
date: 2026-04-22
chapter: <YourChapter>
meeting_type: 例會 | 測試 | 封閉會議-接待組 | 封閉會議-導師團 | ...
test: false                     # true → excluded_from_scoring also true
excluded_from_scoring: false
start: "06:45"                  # Taipei wall-clock
end: "08:00"
attendance_resolved: true
present_count: 30
late_count: 2
absent_count: 3
early_leave_count: 0
visitors: ["王小明"]
source:
  - raw/meetings/2026-04-22/participants.jsonl
  - raw/meetings/2026-04-22/transcript.jsonl
  - raw/roll_calls/2026-04-22.md
created: 2026-04-22
updated: 2026-04-22
```

Rule page (`wiki/rules/<topic>.md`) — flexible structure, each driven by the
handbook content. Common headers: # 目的 / 角色定位 · ## 任務 · ## 與其他角色協作
· ## 注意事項 · ## 相關連結.

### Secrets and auth

Single secrets file `~/.openclaw/secrets/bni-masta.env` (chmod 600, never
committed):

```
OPENROUTER_API_KEY=sk-or-v1-…
ANTHROPIC_API_KEY=sk-ant-…
VEXA_API_KEY=…
VEXA_REGION=ap-northeast-1
VEXA_WEBHOOK_URL=https://<your-webhook-host>/vexa-webhook
VEXA_WEBHOOK_TOKEN=…              (optional shared secret)
ALEX_TELEGRAM_ID=<your-telegram-chat-id>
BNI_BOT_DISPLAY_NAME=BNI Masta(<YourName>副主席習ＡＩ助理)
BNI_BOT_AVATAR_URL=https://<your-webhook-host>/assets/masta-avatar.html
BNI_ROSTER_SHEET_ID=<your-google-sheet-id>
BNI_ROSTER_ACCOUNT=<your-google-account>
```

OAuth profiles (also chmod 600):

- `~/.openclaw/auth-profiles/openai-codex.json` — GPT-5.4 OAuth (legacy chat
  fallback; not the default anymore)
- `~/.openclaw/auth-profiles/gog.json` — Google OAuth for the `gog` CLI
- `~/.cloudflared/<UUID>.json` — Cloudflare tunnel credentials

Telegram bot token + LINE credentials live in `~/.openclaw/openclaw.json`.

### Cost model

Approximate monthly cost for 4 Friday meetings + ~10 PDFs + ~30 voice notes:

| Item | Estimate |
|---|---|
| OpenRouter (Haiku chat replies) | $0.18 × 4 ≈ $0.72 |
| OpenRouter (Gemini OCR) | ~$1 |
| OpenRouter (Gemini audio transcribe) | ~$1 |
| Anthropic API (Claude wiki compiler) | <$1 |
| Vexa (4 × 90-min meetings) | $0.50 × 6 hrs ≈ $3 |
| Obsidian Sync | $10 |
| **Total** | **≈ $15-17 / month** |

GPT-5.4 (legacy fallback) and Google API are $0 under existing subscriptions.

### Backup + GitHub sync

```
Daily 02:30 — ai.bnimasta.auto-push
  → cd to main repo checkout (refuses to run inside a worktree)
  → git fetch origin main + checkout main + pull --ff-only
  → switch to auto-sync branch (reset --hard from main)
  → rsync live → repo:
      ~/.openclaw/agents/bni-masta/agent/{SOUL.md,skills/,config/} → openclaw/agents/bni-masta/
      ~/.openclaw/agents/bni-masta/services/{*.mjs,lib/,package.json} → services/
      ~/.openclaw/agents/bni-masta/scripts/*.sh → scripts/
      ~/Library/LaunchAgents/{ai.bnimasta.*,com.cloudflare.bni-webhook-tunnel}.plist → ops/LaunchAgents/
      vault → vault/ (excluding raw/, wiki/{members,meetings,chapters,events,reports}/, .obsidian workspace state)
  → git add + commit "auto-push: nightly sync <date>"
  → git push --force-with-lease origin auto-sync
  → Operator reviews + merges auto-sync → main at his discretion

Daily 03:00 — ai.bnimasta.backup
  → tarballs vault + openclaw (excluding logs/workspace) + secrets + cloudflared + LaunchAgents
  → ~/Archive/BNI-Masta-Backups/bni-masta-<date>.tar.gz
  → 30-day retention (deletes older)
```

### Future roadmap (v2)

Not built yet:

- **traffic-lights** v2 — compute Power-of-One green/yellow/red/black per
  member from rolling 6-month attendance + referrals + visitors + 1-to-1s
- **calendar-sync** — wrap `gog` to sync the chapter's Google Calendar with
  meeting events (例會 + 封閉會議 + 春酒 + 一日輔導員培訓 etc.)
- **report-monthly** — first-Friday-of-month rollup PDF emailed to chapter
  leadership
- **slides-gen** — `pptx-creator`-driven slide deck for the副主席's weekly
  3-min education segment
- **member-lookup** — Telegram inline-query support for fast `<your-telegram-alert-bot>
  張大明` lookups from any chat
- **follow-up** — auto-DM ladder for visitor → 來賓回函 → application → onboarding
- **line-notify** — outbound LINE push for personalized reminders to
  members (1-to-1 not done in 60 days, attendance dropping below yellow,
  etc.)

### Operational gotchas (CRITICAL invariants)

> [!warning] **Two-brain rule**: chat brain NEVER writes `wiki/`. Wiki
> compiler NEVER handles channel chat.

> [!warning] **PII boundaries**: `wiki/members/*.md` contain phone / email /
> Telegram IDs. Never commit. Never expose via public Cloudflare endpoint.
> The auto-push script's `.gitignore` rules MUST exclude these.

> [!warning] **Recall payload nesting**: chat_message text is at
> `evt.data.data.data.text` (3 levels). Joins are at `evt.data.data.participant`.
> Reading `evt.data.X` returns empty — this caused a multi-day silent-bot bug
> in April 2026.

> [!warning] **Friday-only digest**: post-meeting-digest skips non-Friday
> dates by default. To force-send: `--force`.

> [!note] **Test meetings**: any meeting with `test: true` /
> `excluded_from_scoring: true` in its YAML is excluded from sheet writes
> and member PALMS bumps. Use this for dry runs.

---

## END OF SOURCE CONTENT

Render the documentation now using the structure listed in the **INSTRUCTIONS**
section at the top. Use Mermaid diagrams generously, create a card grid for
the skill catalog, and surface the operational invariants as warning callouts.
