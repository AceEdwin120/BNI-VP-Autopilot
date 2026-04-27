# BNI-Masta — Command Cheatsheet

Supplements [`SOUL.md`](~/.openclaw/agents/bni-masta/agent/SOUL.md). SOUL owns *how* you talk; this file owns *what commands exist*.

## Vault at hand

`<vault-path>/` — your workspace. Read `wiki/` for grounded answers (via the `obsidian` skill). `raw/` is immutable — only skills append to it, never you directly.

## Skills enabled

**Custom (v1):**
- `pdf-ingest <path>` — chunks PDF → `raw/handbooks/<slug>/` → auto-chains `ingest-claude`
- `ingest-claude [scope] [note]` — shells out Claude to compile `raw/` → `wiki/`
- `member-upsert '<json>'` — appends member record to `raw/inbox/members_<date>.jsonl`
- `transcribe-audio <path> [title]` — OpenRouter Gemini 2.5 Flash → `raw/transcripts/` → auto-ingest
- `zoom-join <url> [pwd] [title]` — dispatches Vexa bot "BNI-Masta" to the Zoom
- `resolve-attendance <YYYY-MM-DD>` — fuzzy-matches participants → `raw/roll_calls/<date>.md`
- `roster-sync` — upserts `wiki/members/*.md` into the BNI sheet (<YourChapter>會員名單 + 紅綠燈 tabs). Uses the `gog` CLI under the operator's `<your-google-account>` account. Sheet id `<your-google-sheet-id>`. Weekly cron + on-demand via `/roster-sync`.
- `meeting-poll` — LaunchAgent (every 60s). Detects Vexa bots that have finished, downloads artifacts, runs the **Post-meeting Pipeline** (a.k.a. post-meeting workflow): `resolve-attendance → ingest-claude → meeting-report → attendance-to-sheet → roster-sync → post-meeting-digest → detailed-meeting-report → meeting-deck-report`. (`post-meeting-line-digest` is wired but no-op'd — superseded by `meeting-deck-report`.) Each skill has a 10-min timeout. Writes `<bot_id>.done` marker per meeting recording per-skill outcomes (`{ resolve_ok, ingest_ok, report_ok, sheet_ok, roster_sync_ok, digest_ok, line_digest_ok, detailed_ok, deck_ok }`). **The pipeline is autonomous** — runs without any chat-brain or Claude-Code involvement; only the `ingest-claude` + `meeting-report` steps shell out to the Claude CLI (the wiki-compiler brain, separate process).
- `detailed-meeting-report <YYYY-MM-DD> <bot_id> [--no-summary] [--force]` — per-member detail report combining attendance + speech. Merges multiple participant_ids of the same person (rejoin from different devices). Outputs: (a) `wiki/meeting_reports/<date>_detailed.md` (per-member rename history + Haiku speech summary + full transcript blocks), (b) Google Sheet `會議詳情` tab (one row per meeting), (c) Google Sheet `Speech Log` tab (one row per transcript chunk, members + visitors + helpers). Per-member Haiku summaries cost ~$0.03/meeting via OpenRouter. Idempotent (writes `<bot_id>.detailed_done`).
- `post-meeting-digest <YYYY-MM-DD> <bot_id> [--force]` — sends a Telegram digest to the operator (`<your-telegram-alert-bot>` → ALEX_TELEGRAM_ID) with attendance counts, pipeline status, summary, action items, and Obsidian/Sheet links. **Friday-only by default** (skips Mon-Thu / Sat-Sun). Idempotent per bot (writes `<bot_id>.digest_sent`). `--force` bypasses both gates.
- `post-meeting-line-digest <YYYY-MM-DD> <bot_id> [--force]` — **DEPRECATED** (2026-04-25): superseded by `meeting-deck-report`. Skill files preserved but `meeting-poll` no-ops it.
- `meeting-deck-report <YYYY-MM-DD> <bot_id> [--force] [--no-line]` — Friday-only. Reads `wiki/meeting_reports/<date>_detailed.md` + roll-call front-matter, builds an interactive HTML deck (Haiku-clustered themes + per-member highlight cards + Haiku-extracted action items, dark theme, keyboard-navigable, `@media print` baked in), renders to PDF via Chrome headless (one slide / page), uploads PDF to Google Drive (`BNI-Masta-Reports/` folder, anyone-reader share via `gog drive share … --to anyone --role reader --force`), then pushes 2 LINE text messages **to all configured targets**: #1 stats summary (應到/實到/全程/遲到/早退/缺席/來賓/Helper + per-bucket lists), #2 Drive PDF view URL. Targets resolved from env: `ALEX_LINE_ID` (always) + `BNI_DECK_LINE_GROUP_IDS` (comma-separated groupIds — currently set to `<YourCrossChapterVPGroup>` 51p group). Per-target failures are isolated (operator critical, groups optional). Cost ~$0.005/run (2 Haiku calls). Idempotent (`<bot_id>.deck_done`). Outputs to vault: `wiki/meeting_reports/<date>_deck.html` + `<date>_deck.pdf`.
- `meeting-report` — produces `wiki/meeting_reports/<date>.md` with overall summary, key decisions, action items (with `[[member]]` owners), and per-speaker 發言重點 digest. Auto-fires after every meeting via `meeting-poll`. Manual trigger: `/meeting-report <YYYY-MM-DD>`.
- `attendance-to-sheet <date>` — closes the loop: writes today's PALMS column into the 出席紀錄 tab + bumps each member's `attendance_pct` (rolling 6-meeting avg). Skips if meeting `test: true`.

**In-meeting chat behaviors (live, driven by vexa-webhook):**
- **Cheer detection ×150 triggers** — `services/lib/meeting-handlers.mjs::isCheerMoment` matches numeric praise (`666`, `888`, `1314`, `520`), Chinese long-form (`太棒`, `超讚`, `牛逼`, `屌爆`, `神級`, `大佬`), content reactions (`滿滿乾貨`, `學到了`, `秒懂`), agreement (`+1`, `贊一個`, `沒錯`), ASCII emoticons (`:) :D XD ^_^`), Unicode emoji (35+ celebration glyphs), English (`thanks`, `amazing`, `gg`, `lit`). Fires a quote from the 60-quote bank when matched.
- **Q&A cache (instant)** — `services/lib/qa-cache.mjs` answers common BNI questions in <100ms with no LLM call: 我們有幾位會員 / 副主席是誰 / 下次會議 / BNI 核心價值有哪些 / etc.
- **Chat reply (Haiku 4.5)** — `services/lib/claude-responder.mjs` routes @-mention questions through `anthropic/claude-haiku-4.5` via OpenRouter. ~2-3s replies. Vault context injected automatically. Set `BNI_USE_OPENCLAW=1` to fall back to GPT-5.4.
- **07:05 Friday roster announcement** — at 07:05 Taipei every Friday during a live meeting, bot posts a numbered roster of present members + visitors + absent list + 出席率 stat in Zoom chat. Idempotent. Self-arms on bot join; retries via maybePostRoster on any subsequent webhook event in the 07:05–07:15 window.

**Operational LaunchAgents (no skill — just running services):**
- `ai.bnimasta.vexa-webhook` — Vexa realtime webhook receiver on `127.0.0.1:18821` (tunneled via cloudflared).
- `ai.bnimasta.assets-server` — serves the lion video-avatar HTML on `127.0.0.1:18822` (tunneled to `<your-webhook-host>/assets/`).
- `ai.bnimasta.meeting-poll` — see above.
- `ai.bnimasta.roster-sync` — Sunday 22:00, pushes vault → Google Sheet.
- `ai.bnimasta.backup` — 03:00 daily, local tarball backup → `~/Archive/BNI-Masta-Backups/` (30-day retention).
- `ai.bnimasta.auto-push` — **02:30 daily**, syncs live `~/.openclaw/agents/bni-masta/` + safe vault docs into the GitHub repo and force-pushes to the **`auto-sync`** branch on `<your-github-repo>`. Excludes secrets, member PII, raw/, per-meeting state, logs. Review/merge `auto-sync → main` at your discretion. Log: `~/.openclaw/agents/bni-masta/scripts/auto-push.log`.
- `com.cloudflare.bni-webhook-tunnel` — cloudflared tunnel for both webhook + assets paths.

**Bundled:**
- `obsidian` — vault read/write
- `gog` — Google Calendar (bound to dedicated BNI calendar) + Gmail + Drive + Sheets
- `nano-pdf` — PDF manipulation
- `github` — `gh` CLI
- `openai-whisper-api` — transcription fallback

**v2 not yet built:** `traffic-lights` · `calendar-sync` · `report-monthly` · `slides-gen` · `member-lookup` · `follow-up` · `line-notify`.

## Routing table (what the operator sends → what you run, no confirmation)

| Input | Action |
|---|---|
| `.pdf` file | `pdf-ingest <path>` |
| `.mp3` / `.m4a` / `.wav` / `.ogg` / `.mp4` / voice note | `transcribe-audio <path>` |
| Anything containing `zoom.us/j/...` OR `Zoom` / `視訊` / `會議` / `join zoom` / `加入會議` / `加入Zoom` / `加入視訊` / `Zoom 會議` / `線上會議` / `會議連結` / `會議室` (multilingual) combined with a URL OR (meeting ID + pwd) | `zoom-join <url> <pwd>` (default workflow whenever the user asks to join a Zoom meeting; see SOUL.md "Zoom-join recognition" for full rules) |
| "Add <name>, <expertise>, <chapter>" | `member-upsert '{...}'` |
| Rule question ("封閉會議是什麼?") | `obsidian` read `wiki/rules/<topic>.md` → 1-sentence answer + `[[link]]` |
| Member question ("張大明 最近的 1-to-1 是什麼時候?") | `obsidian` read `wiki/members/<name>.md` |
| Date + title ("5/15 春酒 7pm 台北101") | `gog calendar create` on BNI calendar |
| "更新會員名單" / "sync the sheet" / "算這週紅綠燈" | `roster-sync` |

## When you must confirm (the only 3 cases)

Per SOUL, these require a ≤1-line confirm question before acting:

1. **Destructive** — deleting wiki/members/, overwriting raw/, removing files, force-push, `rm -rf`
2. **Costs >$1** — PDF ingest >300 pages; traffic-lights on >200 members; long audio (>2h) transcription
3. **External broadcast** — LINE push to members; calendar invite with other attendees; email send

Format: `確認: <action>? y/n`

## Known LINE groups (push targets)

bni-masta LINE bot (`<your-line-bot-id>`) is in these groups — see [`wiki/reference/line_groups.md`](wiki/reference/line_groups.md) for full details + push commands + access policy.

| groupName | groupId | members | use |
|---|---|---|---|
| `<YourTestGroup>` | `<your-line-group-id>` | 3 | test |
| `<YourChapterMainGroup>` | `<your-line-group-id>` | 31 | <YourChapter>主群組 — broadcast |
| `<YourCrossChapterVPGroup>` | `<your-line-group-id>` | 51 | 跨分會副主席交流 |

LINE Messaging API has **no `GET /v2/bot/groups`** — bot only learns groups via `join`/`message` webhook events. New group? Have someone send any message in it, then `grep groupId ~/.openclaw/agents/bni-masta/sessions/sessions.json | sort -u` and look up the new ID via `curl …/v2/bot/group/<id>/summary`.

## LINE access policy (DM = operator only, groups = silent for everyone)

Since 2026-04-25, LINE inbound is locked down at the OpenClaw gateway layer (`~/.openclaw/openclaw.json → channels.line`):

```json
{ "dmPolicy": "allowlist", "allowFrom": ["<your-line-user-id>"],
  "groupPolicy": "disabled" }
```

- **The operator DMs** → bot replies
- **Anyone else's DMs** → silently dropped at gateway (no LLM call, no log)
- **All LINE group messages** (incl. the operator's own) → silently dropped — bot never speaks in any group
- **Outbound push** (Friday digest, deck-report PDF link to groups) is **not** affected — token-holder can always push to any userId/groupId via the Messaging API
- To re-enable group replies for the operator: switch `groupPolicy` to `"allowlist"` + add `"groupAllowFrom": ["<your-line-user-id>"]`. OpenClaw hot-reloads, no restart needed.
- To re-enable group replies for everyone: `groupPolicy: "open"`

## Repo is a template — not a fully bootable copy

The GitHub repo (`<your-github-repo>` (template-fork target), `auto-sync` branch) contains code, vault structure, and runbooks — but **never** secrets or PII. If a future user clones it onto a fresh Mac, they need to **separately provision**:

1. **Secrets** in `~/.openclaw/secrets/bni-masta.env` (chmod 600) — `VEXA_API_KEY`, `OPENROUTER_API_KEY`, `LINE_CHANNEL_*`, `BNI_BOT_TOKEN` (Telegram), `ALEX_LINE_ID`, `ALEX_TELEGRAM_ID`, `BNI_CALENDAR_ID`
2. **OAuth profiles** in `~/.openclaw/auth-profiles/` — re-run `openclaw models auth login --provider openai-codex` (GPT-5.4), `gog auth add ... --services gmail,calendar,drive,sheets`, and `claude` (CLI login for wiki compiler brain)
3. **Cloudflare named tunnel** in `~/.cloudflared/` — `cloudflared tunnel login + create + route dns` for the webhook hostname
4. **`~/.openclaw/openclaw.json`** runtime config — generated by `openclaw onboard` then patched from `openclaw/openclaw.json.template`. Contains the LINE access policy (`dmPolicy=allowlist`, `allowFrom=[<owner userId>]`, `groupPolicy=allowlist`, `groupAllowFrom=[<owner userId>]`) — **must be set per owner**, not shared.
5. **Vault PII** (`wiki/{members,meetings,chapters,events,reports,meeting_reports}/`, `raw/`) — for the original creator restore from `~/Archive/BNI-Masta-Backups/<date>.tar.gz`; for a new chapter start empty and onboard via `member-upsert` + `pdf-ingest`.

Full provisioning checklist + source URLs in the repo's [`README.md`](https://github.com/<your-github-org>/<your-github-repo>/blob/auto-sync/README.md) → "What's NOT in this repo" section.

## Boundary

You are the chat brain. You **never** write to `wiki/` directly. When new content appears in `raw/`, invoke `ingest-claude` and let Claude do the compile.
