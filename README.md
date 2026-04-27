# BNI-Masta

<p align="center">
  <img src="assets/hero-banner.png" alt="自動化的BNI副主席 — BNI Vice President Autopilot" width="600">
</p>

> **作者：馬驊（Alex）**　·　BNI <YourChapter> 副主席　·　[蟬說](https://www.chanshuo.tw/) 創辦人　·　[痛點科技](https://painpoint-ai.com/) 創辦人  
> **Created by Alex Ma (馬驊)** — BNI <YourChapter> Vice President · Founder of [Chanshuo (蟬說)](https://www.chanshuo.tw/) · Founder of [PainPoint Tech (痛點科技)](https://painpoint-ai.com/)

---

## 🇹🇼 中文說明

### 願景：把副主席的工作全自動化

**BNI-Masta** 是一個以「全自動化副主席任務」為目標的 AI agent。它把分會副主席日常那些既重複、又非常耗時的工作全部交給機器處理 —— 讓真人副主席只需要把心力留給真正需要人判斷的決策上。

簡言之：**等同一位永遠在線、不會忘事、會主動參與會議、會做完整會議記錄、會發出席公告、會回答任何分會歷史問題的全能副主席助理。**

### 核心能力

**🎬 會議中（每週五早上 BNI 例會）：**

- 自動派遣 Vexa 機器人登入 Zoom 會議
- **自動點名** — 用 5 層 fuzzy match 把 Zoom 顯示名稱對到會員名冊，準確判斷每位夥伴的狀態（準時 / 遲到 / 早退 / 全程 / 缺席 / 代理人）
- 主動在 Zoom chat 提醒會員把顯示名稱改成 BNI 標準格式 `編號｜姓名｜專業`
- 即時辨識誰是正式會員、誰是來賓、誰是 Helper —— 同樣對來賓與 Helper 提醒改名規範（例如 `來賓/王小華/品牌設計` 或 `helper/李大明/AI 顧問`）
- 全程錄製會議聲音，自動生成繁體中文逐字稿
- 在會議裡回答夥伴提問（@BNI Masta）—— 從分會自己的知識庫即時抓答案

**📋 會後（自主完成，大約 30 分鐘內）：**

- 產生完整會議報告 —— 包含每位夥伴的發言重點、行動項目、決議事項、推薦交換、來賓邀約紀錄
- 把全部資料整理進這個分會專屬的 LLM-Wiki 知識庫（會員頁面、會議頁面、規則頁面互相 cross-link）
- 出席資料同步到 Google Sheet（紅綠燈計算的基礎）
- 透過副主席本人的個人 LINE 帳號，把 BNI 標準格式的「會後出席公告」發到指定 LINE 群組 —— 包含 bot 因 LINE 1-OA-per-group 規則無法進入的跨分會群（例如副主席交流群）

**📚 長期累積（每場會議都進知識庫）：**

- 每次例會的會議內容、聲音逐字稿、結論、行動項目、出席統計（出席率 / 遲到率 / 早退率 / 缺席率）—— 全部累積在分會的 LLM-Wiki 知識庫
- 副主席任何時候都能透過 Telegram 或 LINE 用自然語言查詢，例如「上週某某夥伴的 1-to-1 紀錄」、「3 月份紅綠燈統計」、「過去半年缺席最多的成員」—— AI 直接從知識庫回答
- 知識庫本身是 Obsidian vault，副主席也能視覺化瀏覽、看分會會員與會議之間的關聯圖

### 系統介面

一個系統、三個對外介面：

- **Telegram**（`<your-telegram-alert-bot>`）— 日常驅動，<YourName>（操作員）用 DM 下指令
- **LINE** — 同一個 agent，可透過 LINE 推送訊息（給台灣會員用）
- **Obsidian vault** — <YourName>視覺瀏覽分會知識庫的介面

建構於 [OpenClaw](https://openclaw.ai)。遵循 [Karpathy 的 LLM-Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — Obsidian vault 本身就是資料庫，沒有 RAG、沒有 embeddings、沒有額外的 vector store。

### 兩個腦袋 (雙腦架構)

- **聊天腦** = GPT-5.4 透過 OpenAI Codex OAuth（ChatGPT 訂閱戶免費）。Telegram / LINE 訊息快速回應
- **Wiki 編譯腦** = Claude 透過 `claude` CLI。讀 `raw/`（不可變的原始資料）並維護 `wiki/`（結構化、互相 cross-link 的 markdown）。透過 `ingest-claude` skill 按需執行

### 第一階段功能 (v1)

| Skill | 觸發 | 效果 |
|---|---|---|
| `pdf-ingest` | <YourName> 送 PDF 或 `/pdf-ingest <path>` | 切割 PDF → `raw/handbooks/` → 觸發 Claude 編譯 |
| `ingest-claude` | 自動或 `/ingest-claude` | 殼出 Claude；依 `vault/CLAUDE.md` 編譯 `raw/` → `wiki/` |
| `member-upsert` | <YourName> 主動提供已知會員的新資訊 | 將 JSON 附加到 `raw/inbox/members_<date>.jsonl` |
| `transcribe-audio` | <YourName> 送語音 / 音訊檔 | OpenRouter Gemini 2.5 Flash → `raw/transcripts/` |
| `zoom-join` | `/zoom-join <url> <pwd>` | 派遣 Vexa 機器人 "BNI-Masta" 加入 Zoom |
| `resolve-attendance` | Vexa webhook 觸發 `bot.done` 後自動 | 三層 fuzzy match (exact → Levenshtein → Claude) → `raw/roll_calls/<date>.md` |

### 會議中互動 (v1)

機器人透過 Vexa 加入後，會主動參與 Zoom 聊天：
- **自我介紹** — 發布一行自介（僅限週五 06:45–07:30 台北時間）
- **歡迎 + 名稱檢查** — 對 35 位會員名冊做 fuzzy match；提示會員改成 `編號｜姓名｜專業` 格式；歡迎來賓
- **@-mention LLM 回覆** — `@BNI Masta <問題>` → ~7 秒上下文回答（GPT-5.4 透過 Codex OAuth 免費）
- **歡呼引言** — 有人輸入正面留言（`太棒了`、`感謝`、👏）時，從 30 句 BNI 引言庫挑一句回應
- **限制：** 50 次自由回覆 / 場 · 5 秒回覆冷卻 · 公開聊天獨家（私訊直接丟棄）

### 已 Tag 的核心能力 (snapshot)

目前 `main` 上有三條穩定的頂層 pipeline，每條都有 git tag 與 vault 內專屬參考頁：

| Tag | 能力 | 觸發 | 參考 |
|---|---|---|---|
| (無 tag) | **Pipeline #1 — Post-meeting Pipeline**（自主、bot 驅動、**10 步驟**鏈，由 `meeting-poll` LaunchAgent 在 Vexa `bot.done` 後啟動；v3.3 加了 Step 10 = `personal-line-broadcast --write-plan` 來把資料交棒給 Pipeline #2） | 每次週五例會自動 | `vault/wiki/reference/post-meeting-pipeline.md` |
| `linpc-v1.0` | **Pipeline #2 — Post-meeting LinePc Pipeline**（`personal-line-broadcast` planner + Claude Desktop Computer Use executor，給 bot 因 LINE 1-OA-per-group 限制無法進入的群組用）。**v3.3（2026-04-27）已全自動：週五早上**— Pipeline #1 Step 10 寫 plan；Anthropic 排程任務 `post-meeting-cu-primary`（週五 09:30）+ `post-meeting-cu-backup-and-escalate`（週五 11:00）透過 CU 投遞 + 重試 + Telegram 告警。訊息格式改成 BNI 副主席標準會後出席公告（標頭 + 零填充統計區塊 + 各 bucket 會員清單含 編號 + 英文別名） | 週五早上自主 | `vault/wiki/reference/post-meeting-linepc-pipeline.md` |
| `ai-news-v1.0` | **AI News Broadcaster Pipeline (#3)** — v3 階梯式，每天 09:00 台北時間透過 launchd 啟動。Apify 爬蟲（72 小時視窗）→ OpenRouter Haiku 整理 + zh-TW 翻譯 + 互動 CTA → 6 頁 PDF → 3 個目的地依序投遞：09:00 bot LINE → `<YourTestGroup>`（canary）· 09:05 寫 plan + Anthropic 排程任務 CU → `<YourCommunityGroup>`（因 ~8 分鐘 dispatch 延遲實際 ~09:14）· 09:20 bot LINE → `<YourChapterMainGroup>`。每階段 bot 重試 3 次（指數退避）；失敗 → 透過 `<your-telegram-alert-bot>` Telegram 告警 + 停止剩餘階段。CU 自動恢復：`ai-news-cu-primary` 任務 09:05 + `ai-news-cu-backup-and-escalate` 10:00 | 每日排程 | `vault/wiki/reference/ai-news-broadcaster.md`、`openclaw/agents/bni-masta/extensions/ai-news-broadcaster/MANIFEST.md` |

### Repo 結構（重點）

- `openclaw/agents/bni-masta/skills/` — 所有 BNI Masta skills（v1 框架 31 檔案，sha256 pinned）
- `openclaw/agents/bni-masta/extensions/ai-news-broadcaster/` — 第 3 條 pipeline 的嚴格 additive 擴充
- `vault/` — Obsidian vault 結構（不含成員 PII）
- `services/` — `vexa-webhook.mjs` 等常駐服務
- `scripts/` — 安裝、部署、auto-push、backup 腳本

### 找更多資訊

- **Template 使用指南**：[TEMPLATE.md](TEMPLATE.md)（先看這個，所有要替換的 placeholder 都在這）
- **安裝指南**：[RUNBOOK.md](RUNBOOK.md)
- **架構圖 + 資料流**：[ARCHITECTURE.md](ARCHITECTURE.md)
- **新 Claude session 上手**：[CLAUDE.md](CLAUDE.md)
- **完整框架文件**：[docs/framework-documentation-prompt.md](docs/framework-documentation-prompt.md)
- **License**：[MIT](LICENSE)

### 不在這個 repo 裡的東西

這個 repo 是個 **template** — 含程式碼、schema、agent system prompt、LaunchAgent plist、vault 結構、runbook，但**絕不**含 secret 或個資。要真的執行，目標機器需自行準備：

1. **Secrets** in `~/.openclaw/secrets/bni-masta.env`（chmod 600）— `VEXA_API_KEY`、`OPENROUTER_API_KEY`、`LINE_CHANNEL_*`、`BNI_BOT_TOKEN`、`ALEX_LINE_ID`、`ALEX_TELEGRAM_ID`、`BNI_CALENDAR_ID`、`APIFY_TOKEN`
2. **OAuth profiles** — OpenAI Codex（GPT-5.4 聊天腦，ChatGPT Plus/Pro/Team 免費）、Google（`gog` CLI）、Anthropic（Claude CLI）
3. **Cloudflare named tunnel** — Vexa + LINE webhook 入口
4. **`~/.openclaw/openclaw.json`** runtime config — bot 帳號、gateway port、LINE 訪問策略
5. **Obsidian vault PII** — 從 `~/Archive/BNI-Masta-Backups/` 還原，或新分會從零建檔

完整 provisioning 清單見英文版下方「What's NOT in this repo」章節。

---

## 🇬🇧 English

### Mission: fully automate the 副主席 (Vice President) role

**BNI-Masta** is an AI agent built to fully automate the day-to-day work of a 副主席 (Vice President) at a BNI chapter. It takes the repetitive, time-consuming chores out of the role and lets the human VP focus on the decisions that actually need human judgment.

In short: **a tireless, always-on, never-forgets digital VP assistant that joins the meeting in person, takes complete meeting minutes, publishes the attendance announcement, and answers any historical chapter question on demand.**

### Core capabilities

**🎬 During the meeting (Friday morning BNI 例會):**

- Auto-dispatches a Vexa bot to join the Zoom meeting
- **Automated roll-call** — a 5-tier fuzzy-match cascade resolves Zoom display names against the chapter roster, classifying every member's attendance state (準時 on-time / 遲到 late / 早退 left-early / 全程 full-meeting / 缺席 absent / 代理人 substitute)
- Proactively reminds members in Zoom chat to rename their display name to the BNI standard format `編號｜姓名｜專業` (#-id｜name｜expertise)
- Recognises members vs visitors (來賓) vs helpers in real time — and nudges visitors/helpers to follow the corresponding naming convention (e.g. `來賓/王小華/品牌設計` or `helper/李大明/AI consultant`)
- Records the meeting audio and produces a complete Traditional-Chinese transcript automatically
- Answers questions in the meeting itself (`@BNI Masta` mentions) — pulling answers from the chapter's own knowledge base in real time

**📋 After the meeting (autonomous, within ~30 minutes):**

- Generates a detailed meeting report — speech highlights per member, action items, decisions, referrals exchanged, visitor-invite records
- Writes everything into the chapter's dedicated LLM-Wiki knowledge base (member pages, meeting pages, and rule pages all cross-link to each other)
- Syncs attendance data to the Google Sheet (which feeds the BNI traffic-lights calculation)
- Uses the VP's **personal** LINE account to publish the BNI standard chapter-announcement message (attendance counts + per-bucket member listings with member ID and English alias) to the designated LINE groups — including cross-chapter groups the bot account cannot enter due to LINE's 1-OA-per-group rule (e.g. the cross-chapter VP forum)

**📚 Long-term accumulation (every meeting feeds the knowledge base):**

- Every meeting's content, audio transcript, conclusions, action items, and attendance statistics (attendance rate / late rate / early-leave rate / absence rate) accumulate in the chapter's LLM-Wiki knowledge base
- The VP can ask via Telegram or LINE in natural language at any time — "show me member X's 1-to-1 history", "March's traffic-light trend", "members with the most absences over the past 6 months" — and the AI answers directly from the knowledge base
- The knowledge base IS an Obsidian vault, so the VP can also browse it visually and see the relationship graph between chapter members and meetings

### Interfaces

One system, three surfaces:

- **Telegram** (`<your-telegram-alert-bot>`) — daily driver, the operator DMs to run commands
- **LINE** — same agent, reachable via LINE push (for members in Taiwan)
- **Obsidian vault** — the knowledge base the operator browses visually

Built on [OpenClaw](https://openclaw.ai). Follows [Karpathy's LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the Obsidian vault itself is the database, no RAG, no embeddings, no separate vector store.

## Two brains

- **Chat** = GPT-5.4 via OpenAI Codex OAuth (free under ChatGPT subscription). Fast turnaround for Telegram/LINE messages.
- **Wiki compiler** = Claude via `claude` CLI. Reads `raw/` (immutable sources) and maintains `wiki/` (structured cross-linked markdown). Runs on-demand via the `ingest-claude` skill.

## What it can do (v1)

| Skill | Trigger | Effect |
|---|---|---|
| `pdf-ingest` | The operator sends a PDF or `/pdf-ingest <path>` | Chunks PDF → `raw/handbooks/` → triggers Claude compile |
| `ingest-claude` | Auto or `/ingest-claude` | Shells out Claude; compiles `raw/` → `wiki/` per `vault/CLAUDE.md` |
| `member-upsert` | The operator volunteers new info about a named member | Appends JSON to `raw/inbox/members_<date>.jsonl` |
| `transcribe-audio` | The operator sends a voice note / audio file | OpenRouter Gemini 2.5 Flash → `raw/transcripts/` |
| `zoom-join` | `/zoom-join <url> <pwd>` | Dispatches Vexa bot "BNI-Masta" to join the Zoom |
| `resolve-attendance` | Auto after Vexa webhook fires `bot.done` | 3-tier fuzzy match (exact → Levenshtein → Claude) → `raw/roll_calls/<date>.md` |

## In-meeting interaction (v1)

Once the bot joins via Vexa, it actively participates in Zoom chat:
- **Intro** — posts a one-line self-intro (Friday 06:45–07:30 Taipei window only)
- **Greet + name-check** — fuzzy-matches new joiners against the 35-member roster; nudges members to the `編號｜姓名｜專業` format; welcomes 來賓
- **@-mention LLM reply** — `@BNI Masta <question>` → ~7s contextual answer via GPT-5.4 (free under Codex OAuth)
- **Cheer-quote** — when someone types positive chat (`太棒了`, `感謝`, 👏), bot drops a short BNI quote from a 30-quote bank
- **Caps:** 50 free-form replies/meeting · 5s inter-reply cooldown · public chat only (private chat hard-dropped)

## v2 (not built yet)

`traffic-lights` · `calendar-sync` (wraps bundled `gog` on a dedicated "BNI" Google Calendar) · `report-monthly` · `slides-gen` · `member-lookup` · `follow-up` · `line-notify` (outbound LINE push for reminders).

## Post-meeting digests (Telegram + LINE)

After every Friday 例會, the post-meeting chain ends with two parallel digests:

- **Telegram** (`<your-telegram-alert-bot>` → operator's chat) — pipeline status, attendance counts, summary, action items, Obsidian + Sheet links. Friday-only; idempotent per bot.
- **LINE** (`ALEX_LINE_ID`) — the BNI 副主席 standard 「每週會後公布夥伴出席狀況」 template: 應到 / 實到 / 代理 / 遲到 / 缺席 / 來賓 counts + per-bucket lists formatted as `<編號><姓名>`. Built from `raw/roll_calls/<date>.md` front-matter (which `resolve-attendance` populates with all the count + list fields).

Test/non-Friday meetings skip both with `{skipped: …}` markers.

### 代理人 (substitute) detection

When a member sends a substitute, the substitute joins Zoom with display name `<member>-代理人` (e.g. `01｜張大明｜商業保險-代理人`). The bot's `roster-match` detects the `代理人` keyword, strips it, matches the cleaned name to the original member, and records PALMS `S` (0.5) on that member's row. The original member's `attendance_pct` doesn't tank; the substitute's display name is captured in `substitutes[].by` for the digest. The in-meeting name-nudge teaches members this convention proactively.

### 07:05 hard cutoff (Friday only)

Friday morning 例會 follows BNI's hard 07:05 Taipei cutoff: any member arriving after 07:05 is recorded as 遲到 (still counts toward 實到). Other meeting types (封閉會議, training) use a flexible `start + 15min` grace.

## Backups + GitHub auto-push

Two LaunchAgents run nightly so you don't need to do anything manual:
- **02:30 daily — `ai.bnimasta.auto-push`** — syncs live `~/.openclaw/agents/bni-masta/` (skills, services, SOUL, agent config) + safe vault docs (rules/templates/dashboards) into this repo and force-pushes the `auto-sync` branch on GitHub. Excludes secrets, member PII, raw/, per-meeting state, logs. Review/merge `auto-sync → main` at your discretion.
- **03:00 daily — `ai.bnimasta.backup`** — local tarball of vault + openclaw + secrets + cloudflared + LaunchAgents → `~/Archive/BNI-Masta-Backups/` (30-day retention).

## ⚠ What's NOT in this repo (template — provision yourself)

This repo is a **template**. It contains all code, schemas, agent system prompts, LaunchAgent plists, vault structure, and runbooks — but **never** secrets or personal data. Before anything will run, you must obtain or recreate the following on the target machine:

### A. Secrets / tokens (~/.openclaw/secrets/bni-masta.env, chmod 600)

| Variable | Where to get it | Used by |
|---|---|---|
| `VEXA_API_KEY` | [vexa](https://vexa) → API Keys | `zoom-join`, `meeting-poll` |
| `VEXA_REGION` | usually `ap-northeast-1` for Asia/Pacific | same |
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai/keys) → starts with `sk-or-...` | `transcribe-audio`, `detailed-meeting-report`, `meeting-deck-report`, `claude-responder` (Haiku 4.5) |
| `ANTHROPIC_API_KEY` | optional fallback for OpenRouter | n/a (default uses OpenRouter) |
| `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` | [LINE Developers Console](https://developers.line.biz) → Messaging API channel | LINE bot |
| `ALEX_LINE_ID` | your own LINE userId (`U` + 32 hex) — captured the first time you DM the bot | outbound LINE push |
| `BNI_BOT_TOKEN` | Telegram `@BotFather` → `/newbot` | Telegram bot |
| `ALEX_TELEGRAM_ID` | your Telegram chat_id — get via [@userinfobot](https://t.me/userinfobot) | outbound Telegram push |
| `BNI_CALENDAR_ID` | Google Calendar → create dedicated "BNI" calendar → copy ID | `calendar-sync` (v2) |

### B. OAuth profiles (~/.openclaw/auth-profiles/, regenerated by browser flow)

| Profile | Command to regenerate |
|---|---|
| OpenAI Codex (GPT-5.4 chat brain — free under ChatGPT Plus/Pro/Team) | `openclaw models auth login --provider openai-codex` |
| Google (`gog` CLI for Sheets / Drive / Calendar / Gmail) | `gog auth credentials ~/path/to/google_client_secret.json && gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets` |
| Anthropic (Claude CLI for wiki compiler brain) | `claude` (first run prompts for login) |

### C. Cloudflare named tunnel (~/.cloudflared/, browser flow)

```bash
cloudflared tunnel login           # browser, picks your CF account
cloudflared tunnel create bni-webhook
cloudflared tunnel route dns bni-webhook bni-webhook.<your-domain>.com
# Edit ~/.cloudflared/config-bni.yml with the new tunnel UUID and your hostname
```
Without this, Vexa + LINE webhooks can't reach your Mac → no realtime events, no in-meeting bot interaction, no LINE replies.

### D. OpenClaw runtime config (~/.openclaw/openclaw.json)

This file wires up bot accounts, gateway port, channel filters (`dmPolicy`, `allowFrom`, `groupAllowFrom`), and per-agent skill mappings. Generated on a fresh install by `openclaw onboard`, then patched by `scripts/install.sh` from `openclaw/openclaw.json.template` substituting your env vars. **Note:** the template intentionally has empty token fields — fill them after onboarding.

### E. Obsidian vault PII (~/Documents/BNI AGENT/BNI AGENT/wiki/{members, meetings, chapters, events, reports, meeting_reports}/ + raw/)

This repo contains the **vault structure** (`vault/wiki/{rules, index, log}.md`, `_templates/`, `_dashboards/`, `wiki/reference/`) but **NOT** member data, meeting history, or raw artifacts (member contact info, attendance records, transcripts, OCR'd handbooks). Sources:

- **For the original creator's clone**: restore from `~/Archive/BNI-Masta-Backups/<date>.tar.gz` (the daily local backup)
- **For a brand-new chapter**: start empty — onboard members one-by-one with `member-upsert`, OCR the handbook with `pdf-ingest`, run `ingest-claude` to compile the vault

### F. Off-site backup (recommended, NOT auto-configured)

The bundled `backup.sh` writes daily tarballs to `~/Archive/BNI-Masta-Backups/` — **local-only, 30-day retention**. For DR (Mac dies, theft, etc.) you should also rsync those tarballs to a private cloud:

```bash
# Add to ~/.openclaw/agents/bni-masta/scripts/backup.sh after the tarball write:
rclone copy ~/Archive/BNI-Masta-Backups/ remote:bni-backups/ --max-age 7d
# or: aws s3 sync ~/Archive/BNI-Masta-Backups/ s3://my-bucket/bni-backups/
```

### Quick checklist before first launch

```
[ ] secrets/bni-masta.env populated (chmod 600)
[ ] openclaw.json present + bot tokens filled
[ ] OpenAI Codex OAuth done (test: `openclaw chat hello`)
[ ] gog OAuth done (test: `gog calendar list`)
[ ] Claude CLI installed + logged in (test: `claude --print "hi"`)
[ ] Cloudflared tunnel up (test: `curl -sI https://<your-host>/vexa-webhook`)
[ ] LaunchAgents loaded (verify: `launchctl list | grep -E "ai\.bnimasta|ai\.openclaw"`)
[ ] First Vexa webhook arrives → check `tail -f ~/.openclaw/logs/gateway.log`
```

## Installation (fresh Mac)

See [RUNBOOK.md](RUNBOOK.md) for the step-by-step.

## Architecture diagram + data flow

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Onboarding a new Claude session

See [CLAUDE.md](CLAUDE.md) — Claude reads this first when opening the repo.

## Full framework documentation (for visual rendering)

See [docs/framework-documentation-prompt.md](docs/framework-documentation-prompt.md) — a self-contained specification covering concept, aim, architecture, every skill, every LaunchAgent, all three pipelines, the vault data model, external integrations, cost model, and the two-brain invariant. Designed to be fed verbatim to a visual-documentation model (e.g. Claude design) which will render it as diagrams + card grids + callouts.

## Tagged capabilities (snapshot)

Three top-level capabilities are now stable on `main`, each with a git tag and its own reference page in the vault:

| Tag | Capability | Trigger | Reference |
|---|---|---|---|
| (no tag) | **Pipeline #1 — Post-meeting** (autonomous bot-driven **10-step** chain via `meeting-poll` LaunchAgent on Vexa `bot.done`; v3.3 added Step 10 = `personal-line-broadcast --write-plan` to hand off Pipeline #2) | per Friday meeting, automatic | `vault/wiki/reference/post-meeting-pipeline.md` |
| `linpc-v1.0` | **Pipeline #2 — Post-meeting LinePc** (`personal-line-broadcast` planner + Claude Desktop Computer Use executor for groups bot can't enter due to LINE 1-OA-per-group). **v3.3 (2026-04-27): now fully autonomous on Friday** — Pipeline #1 Step 10 writes the plan; Anthropic scheduled tasks `post-meeting-cu-primary` (Fri 09:30) + `post-meeting-cu-backup-and-escalate` (Fri 11:00) deliver via CU + retry + Telegram-escalate. Message body switched to BNI 副主席 chapter-announcement format (header + zero-padded stats block + per-bucket member listings with 編號 + English alias) | autonomous Friday morning | `vault/wiki/reference/post-meeting-linepc-pipeline.md` |
| `ai-news-v1.0` | **AI News Broadcaster Pipeline (#3)** — v3 staggered, daily 09:00 Taipei via launchd. Apify scrape (72h window) → OpenRouter Haiku curate + zh-TW translate + interaction CTA → 6-page PDF → 3 destinations sequentially: 09:00 bot LINE → `<YourTestGroup>` (canary) · 09:05 plan-write + Anthropic-scheduled-task CU → `<YourCommunityGroup>` (~09:14 actual due to ~8 min dispatch delay) · 09:20 bot LINE → `<YourChapterMainGroup>`. Per-stage bot retry 3× with exp-backoff; on failure → Telegram alert via `<your-telegram-alert-bot>` + halt remaining stages. CU leg auto-recovery: `ai-news-cu-primary` task at 09:05 + `ai-news-cu-backup-and-escalate` at 10:00 (Telegram-escalates if Mac was off / Claude Desktop unavailable). | scheduled daily | `vault/wiki/reference/ai-news-broadcaster.md`, `openclaw/agents/bni-masta/extensions/ai-news-broadcaster/MANIFEST.md`, `extensions/ai-news-broadcaster/config/schedule.json` |

The AI News Broadcaster lives at `openclaw/agents/bni-masta/extensions/ai-news-broadcaster/` and follows a **strictly-additive contract**: the 31-file framework baseline (sha256-pinned at `extensions/ai-news-broadcaster/test-results/stage7-framework-checksums.txt`) is never modified. Future capabilities should follow the same pattern — `extensions/<feature>/`, never edit the framework. See `extensions/ai-news-broadcaster/START_HERE.md` for the entry-point recipe.
