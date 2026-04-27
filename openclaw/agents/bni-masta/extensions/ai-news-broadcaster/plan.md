# AI News Broadcaster — Plan

> **Status:** Stages 1–6 implemented; Stage 7 in progress (integration test + scheduling + install checklist).
> **Version:** 0.5 — 2026-04-26 (Stage 7; Threads dropped permanently per the original creator 2026-04-26 — no longer planned for any future version; layout consolidated under `extensions/ai-news-broadcaster/` with skills nested one level deeper so the parent BNI Masta autoloader does NOT pick them up; `MANIFEST.md` is the integration handoff for any other AI working in this repo)
> **Last updated:** 2026-04-26
> **Owner:** the operator
> **Folder:** `extensions/ai-news-broadcaster/` (net-new top-level; see `MANIFEST.md` for the integration contract)

---

## 1. Goal & Non-goals

### Goal

A new sub-agent that, **every 2 days at 09:00 Taipei**, produces a Traditional Chinese (繁體中文) slide deck of the **top 3 most important AI news items** of the period — sourced from **public Facebook page posts** — adds practical "how <YourChapter> 會員 can use this" tips, broadcasts it to LINE via **both** the BNI Masta bot AND the operator's personal LINE account, and **archives the full run** to a browseable Markdown doc.

### **Translation flow (critical — bolded for visibility)**

> **Source posts come in mostly in English. Every user-facing output — the curated top-3 headlines, the 3 bullet summaries per item, the <YourChapter> tips, the deck slide content, and the LINE message text — is translated into Traditional Chinese (繁體中文) before broadcast.** The only English that survives the pipeline is source attribution (e.g. "@MetaAI on Facebook (English original)") for honesty + traceability. Everything else members read is 繁中.

### Non-goals

- **No edits to any existing skill or file.** Everything net-new.
- **No audio output.** Output is **written only**: a slide-deck PDF + LINE text posts + a Markdown archive doc. No TTS, no podcast, no audio.
- **No X / Twitter scraping.** Dropped entirely (cost). See §6.
- **No Threads scraping — permanently dropped (v0.5, 2026-04-26).** Not in v1; not in any future version. Removed from non-goals as a deferral and from §3 Future as a re-enable target. Source pool is Facebook-only for the lifetime of this feature.
- Not a general AI chatbot. Strictly a curated news pipeline.
- Not multi-language. Output is zh-TW only.
- Not opinionated commentary. Tone = factual digest + actionable tips.
- **No human approval gate.** The orchestrator runs end-to-end automatically; broadcasts go out without a pre-send review. Failures abort + alert; successes just ship.

---

## 2. Constraints (hard)

1. **No-touch rule.** Do NOT modify, rename, move, or delete any file under `bni-masta/` that exists today (verified file list captured before writing this plan; v0.4 re-verified by checksumming all 31 pre-existing files at Stage 1 scaffold). All new code/configs live under `extensions/ai-news-broadcaster/` (see §3 + `MANIFEST.md`).
2. **Additive invocation only.** When this pipeline needs deck-building or LINE-posting, it shells out to the EXISTING scripts (`meeting-deck-report/deck.mjs`, `personal-line-broadcast/broadcast.mjs`, `post-meeting-line-digest/digest.mjs`) WITHOUT modifying them. If their interfaces don't already support news-style payloads, build a thin **adapter** in this folder that re-uses their PRIMITIVES (HTML→PDF rendering, Drive upload, LINE push, computer-use plan JSON) by either (a) writing matching input files and calling them with new flags they already accept, or (b) re-implementing the post-step inside this folder using the same patterns. **Never** add a flag/branch to the existing scripts.
3. **Output language = Traditional Chinese (zh-Hant).** Slide titles, bullets, tips — all 繁體. Source attribution lines may keep the original page name for honesty (e.g., "Meta AI on Facebook · 2026-04-25 (English original)").
4. **Idempotent + per-target failure isolation**, mirroring the existing pipeline's conventions.
5. **Cost ceiling:** ≤ US$1 per run (per SOUL.md §"costs >$1 require confirmation"). Default scrape volume + Haiku calls should sit comfortably under $0.30/run.
6. **Secrets** live in `~/.openclaw/secrets/bni-masta.env` — do not invent new secret stores.

---

## 3. Architecture

### Folder layout (all net-new — v0.4 layout)

Everything this feature adds lives under a single dedicated parent folder, `extensions/ai-news-broadcaster/`. The four skill folders are nested one level deeper inside that parent's own `skills/` subfolder — **not** in the project-root `skills/` — so the parent BNI Masta autoloader will NOT pick them up. The orchestrator invokes them by direct path.

```
bni-masta/
  extensions/
    ai-news-broadcaster/                        ← single dedicated parent folder for this feature
      MANIFEST.md                               ← integration handoff for any other AI in this repo
      plan.md                                   ← THIS FILE
      package.json                              ← local-scoped npm manifest (no parent package.json edits)
      skills/
        ai-news-broadcast/                      ← top-level orchestrator
          SKILL.md                              ← (Stage 5) outward-facing skill contract
          broadcast.mjs                         ← (Stage 5) scrape → curate → deck → archive → LINE×2
          sources.json                          ← (Stage 5) the source account list (editable by the operator)
          personal-line-shim.mjs                ← (Stage 5) shim that emits the personal-LINE Computer Use plan
          prompts/
            curate-top3.md                      ← Haiku prompt: rank + pick top 3
            translate-zhTW.md                   ← Haiku prompt: translate/summarize → zh-Hant
            tips-for-huaai.md                   ← Haiku prompt: <YourChapter> tips
        ai-news-scrape/                         ← scraping skill (Apify Facebook only; Threads permanently dropped v0.5)
          SKILL.md
          scrape.mjs                            ← (Stage 2) calls Apify Facebook actor, returns normalized JSONL
        ai-news-deck/                           ← deck-building adapter (vendors meeting-deck-report's PDF/Drive pattern)
          SKILL.md
          build-deck.mjs                        ← (Stage 3) news-specific HTML deck → Chrome-headless PDF → Drive
        ai-news-archive/                        ← first-class browseable archive
          SKILL.md
          write-archive.mjs                     ← (Stage 4) writes archive/ai_news/<YYYY-MM-DD>_<HHmm>.md + INDEX

archive/                                        ← NEW top-level folder under the BNI vault (NOT under skills/)
  ai_news/
    INDEX.md                                    ← rolling index, newest first, links each archived run
    2026-04-26_0900.md                          ← one markdown doc per broadcast (created at run time)
    2026-04-28_0900.md
    ...
```

> **Why a separate parent folder (`extensions/ai-news-broadcaster/`)?** v0.4 requirement: everything this feature adds must be in one clearly-identifiable parent folder, so another AI working in this repo can read a single `MANIFEST.md` and understand exactly what we depend on, what we touch, and what we don't. The `extensions/` parent signals "additive, not core."

> **Why nest the skills inside `extensions/ai-news-broadcaster/skills/` instead of the project-root `skills/`?** v0.4 architecture decision: the parent BNI Masta agent autoloads anything under `bni-masta/skills/`. By nesting one level deeper we guarantee the parent does NOT autoload our four skills — the orchestrator invokes them by direct path. This is the safest no-conflict layout.

> **Why a separate archive?** v0.2 requirement: every broadcast must be browseable later as a first-class document, not just buried in `raw/` markers. The archive doc is the canonical "what we sent on this date" record — it includes raw scrape highlights, the curation rationale, the final 繁中 summaries, the tips, and the deck PDF link.

> **Why four skill folders, not one?** Each is independently testable. `ai-news-scrape` can be run alone to verify Apify wiring; `ai-news-deck` can be run on a hand-crafted top-3 JSON to verify rendering; `ai-news-archive` can be tested with a fixture; `ai-news-broadcast` is the thin orchestrator that chains them and dispatches LINE.

### Re-using existing skills WITHOUT touching them

| Need | Existing primitive | How we re-use it |
|---|---|---|
| HTML→PDF render | Chrome headless invocation in `meeting-deck-report/deck.mjs` (lines 427-433) | **Copy the spawnSync pattern** into `ai-news-deck/build-deck.mjs` (same Chrome path, same flags). Don't import the file — vendoring the 6-line pattern is cleaner than coupling. |
| Drive upload + share | `gog drive upload` + `gog drive share` (deck.mjs lines 285-312) | Same — copy the pattern; pass a different folder name like `BNI-AI-News/`. |
| LINE Messaging API push (bot account) | `post-meeting-line-digest/digest.mjs` `sendLine()` | Same — copy the 15-line `fetch` POST pattern. Token comes from same env. |
| LINE multi-target groups (bot account) | `meeting-deck-report/deck.mjs` `pushTo` + `getLineTargets` | Same — copy. New env var `BNI_AINEWS_LINE_GROUP_IDS` for the news-specific target list (different from `BNI_DECK_LINE_GROUP_IDS`). |
| **Personal LINE broadcast (computer use) — first-class output channel** | `personal-line-broadcast/broadcast.mjs` planner + Claude Desktop executor | **Call it directly as a child process** (see §5.3 + §5.5 for the full invocation contract). The planner's `--dry-run` gives us a literal "OK" payload for testing the wiring before going live. We pass our own `<bot_id>`-shaped UUID (a new UUID per AI-news run, namespaced) so its idempotency markers don't collide with meeting markers. **However**, the existing planner reads meeting-specific data (`raw/roll_calls/<date>.md`, `raw/meetings/<date>/<bot_id>.deck_done`) which our news pipeline does not produce. **Decision:** rather than feeding it meeting fixtures, our orchestrator writes a small **planner shim** (`ai-news-broadcast/personal-line-shim.mjs`) that emits a JSON plan in the SAME shape `personal-line-broadcast/broadcast.mjs` does (`{skill, runtime: "computer-use", targets, messages, markerPath, sendGapMs, instructions}`) but populated from our news payload. The Claude Desktop executor consumes that JSON identically — no edits to the existing skill. After execution, we call `ai-news-broadcast/personal-line-shim.mjs --mark-done '<results>'` to write our own marker under `raw/ai_news/<date>/<run_id>.personal_line_done`. This preserves the existing pattern + executor contract without forking the existing planner. |

> **Idempotency marker naming:** Existing convention is `raw/meetings/<date>/<bot_id>.<step>_done`. For news we use a different namespace: `raw/ai_news/<YYYY-MM-DD>/<run_id>.<step>_done`. New folder, no collision risk.

### Future — what we're keeping in our back pocket

These are NOT planned but the architecture leaves room:

- **X source channel** — only re-enabled if X drops the read-tier price. Architecture supports it; would require a `scrape_x.mjs` module + `X_BEARER_TOKEN` env. Not currently planned.
- **YouTube / Substack ingestion** — different surface entirely (RSS feeds, transcripts). Out of scope; revisit only if FB-only signal proves too thin after a month of operation.

> **Threads is NOT a future channel.** v0.5 (2026-04-26) permanently dropped Threads from the roadmap per the original creator. Do not re-introduce a `"platform": "threads"` branch, a `BNI_AINEWS_THREADS_ENABLED` flag, or a Threads Apify actor pin to this plan or codebase without an explicit operator decision overturning v0.5.

---

## 4. Data flow

```
   ┌──────────────────────────────────────────────────────────────┐
   │ 0. launchctl wakes broadcast.mjs every 2 days at 09:00 Taipei│
   └────────────────────────┬─────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────┐
   │ 1. SCRAPE (ai-news-scrape/scrape.mjs)│
   │    For each source in sources.json:  │
   │    • Facebook page → Apify actor     │
   │      (apify/facebook-posts-scraper)  │
   │    Window: last 48 hrs (matches      │
   │      every-2-day cadence)            │
   │    Output: posts.jsonl (normalized)  │
   │    (Facebook-only; Threads dropped   │
   │     permanently v0.5 — see §3.)      │
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 2. DEDUPE                            │
   │    Hash post text (SimHash or first  │
   │    160 chars, lowercased, stripped). │
   │    Same story posted by 3 accounts   │
   │    → keep the highest-engagement one,│
   │    note "also covered by @x, @y".    │
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 3. RANK (heuristic, no LLM)          │
   │    score = log(likes + reposts*3 +   │
   │            replies*2 + 1) +          │
   │            recency_bonus +           │
   │            source_weight             │
   │    Keep top 30 candidates.           │
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 4. CURATE TOP 3 (Haiku 4.5)          │
   │    Prompt: "Pick the 3 most important│
   │    AI news items from this list. Each│
   │    must be (a) about AI tech/product/│
   │    research/policy, (b) novel — not  │
   │    a rehash, (c) actionable for SMB  │
   │    biz owners in Taiwan."            │
   │    Output: 3 chosen post IDs + brief │
   │    rationale.                        │
   └────────────────┬─────────────────────┘
                    ▼
   ┌══════════════════════════════════════┐
   ║ 5. TRANSLATE/SUMMARIZE → 繁體中文    ║
   ║    *** PRIMARY TRANSLATION STEP ***  ║
   ║    For each top-3 post:              ║
   ║    • 30-char headline (繁中)         ║
   ║    • 3 bullet summary (繁中)         ║
   ║    • Source URL preserved (English)  ║
   ║    English source text NEVER appears ║
   ║    in user-facing deck/LINE output.  ║
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 6. GENERATE TIPS (Haiku 4.5)         │
   │    For each top-3 item:              │
   │    "<YourChapter> 會員可以這樣用：" + 1-2 tips│
   │    Tips angle: business application, │
   │    networking talking points,        │
   │    or skill-building suggestion.     │
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 7. BUILD DECK (ai-news-deck/         │
   │     build-deck.mjs)                  │
   │    Slides:                           │
   │    1. Cover (本週 AI 新聞 / 日期)    │
   │    2. 摘要 (3 headlines at a glance) │
   │    3-5. Top 3 detail (one each):     │
   │         headline / 3 bullets / tips  │
   │         / source link                │
   │    6. 趨勢觀察 (1-line meta-pattern) │
   │    7. 下週見 (CTA)                   │
   │    HTML → Chrome headless → PDF      │
   │    Upload to Drive folder            │
   │    `BNI-AI-News/`. Share anyone-read.│
   └────────────────┬─────────────────────┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 7.5 ARCHIVE (ai-news-archive/        │
   │       write-archive.mjs)             │
   │    Writes archive/ai_news/           │
   │      <YYYY-MM-DD>_<HHmm>.md          │
   │    Contains: timestamp, source list, │
   │    raw scrape highlights, top-3      │
   │    rationale, 繁中 summaries, tips,  │
   │    Drive PDF link.                   │
   │    Updates archive/ai_news/INDEX.md  │
   │    so the operator can browse history.       │
   │    Runs BEFORE LINE pushes so the    │
   │    archive doc URL/path can be       │
   │    referenced in the LINE messages.  │
   └────────────────┬─────────────────────┘
                    ▼
   ┌════════════════════════════════════════════════════════════════════════┐
   ║          8. BROADCAST — both channels are first-class outputs          ║
   ║════════════════════════════════════════════════════════════════════════║
   ║ 8a. LINE BOT push (OA channel)        ║ 8b. PERSONAL LINE push        ║
   ║     via LINE Messaging API            ║     via Computer Use → LINE.app║
   ║     ─────────────────────────         ║     ──────────────────────────║
   ║     Targets:                          ║     Targets:                  ║
   ║     • the operator's userId (always)          ║     • BNI_AINEWS_PERSONAL_    ║
   ║     • BNI_AINEWS_LINE_GROUP_IDS       ║       TARGETS (group display  ║
   ║       (groups where the OA bot is     ║       names — used in groups  ║
   ║       installed; comma-separated      ║       where the OA bot CANNOT ║
   ║       `C`+32hex group IDs)            ║       be installed due to the ║
   ║                                       ║       1-OA-per-group LINE     ║
   ║     Messages (3):                     ║       limit)                  ║
   ║     msg1 = 3-headline summary         ║                               ║
   ║     msg2 = Drive PDF URL              ║     Same 3-message payload    ║
   ║     msg3 = archive doc link (or note  ║     as 8a, sent via Computer  ║
   ║            "詳細存檔" + path)         ║     Use planner shim →        ║
   ║                                       ║     Claude Desktop session →  ║
   ║     Per-target try/catch — one bad    ║     LINE.app keystrokes.      ║
   ║     group does not abort the rest.    ║                               ║
   ║                                       ║     If no live Claude Desktop ║
   ║                                       ║     session is available at   ║
   ║                                       ║     trigger time → write a    ║
   ║                                       ║     "personal_line_pending"   ║
   ║                                       ║     marker; next Claude       ║
   ║                                       ║     Desktop session picks it  ║
   ║                                       ║     up. (See §10.)            ║
   ║                                       ║                               ║
   ║     Per-target try/catch — one bad    ║     Per-target try/catch —    ║
   ║     group does not abort the rest.    ║     one bad group does not    ║
   ║                                       ║     abort the rest.           ║
   ║─────────────────────────────────────────────────────────────────────────║
   ║ 8a and 8b run in PARALLEL — neither blocks the other.                  ║
   ║ Failure in one channel does NOT abort the other.                       ║
   ║ Per-target results recorded for both channels.                         ║
   └════════════════════════════════════════════════════════════════════════┘
                    ▼
   ┌──────────────────────────────────────┐
   │ 9. WRITE MARKERS                     │
   │    raw/ai_news/<date>/<run_id>.{     │
   │      scrape_done,                    │
   │      curate_done,                    │
   │      deck_done,                      │
   │      archive_done,                   │
   │      bot_line_done,                  │
   │      personal_line_done }            │
   │    Per-target results captured for   │
   │    BOTH LINE channels (8a + 8b).     │
   └──────────────────────────────────────┘
```

---

## 5. Components to build

Each is a new skill folder with `SKILL.md` + script. None modify existing files.

### 5.1 `ai-news-scrape/`

- **SKILL.md** — describes inputs (sources.json), outputs (`posts.jsonl`), env (`APIFY_TOKEN`).
- **scrape.mjs** — calls Apify's `apify/facebook-posts-scraper` actor (REST `actor-call` endpoint, sync run mode) for each enabled FB page in `sources.json`. Returns normalized JSONL.
- Normalized output JSONL fields: `{platform: "facebook", handle, page_url, post_id, url, text, posted_at, likes, comments, shares, lang, source_weight}`.
- **CLI:** `node scrape.mjs --since 48h --out posts.jsonl`.
- **Cost gate:** prints estimated Apify cost before running; aborts if > `MAX_SCRAPE_COST_USD` (default 0.50).

### 5.2 `ai-news-deck/`

- **SKILL.md** — inputs (a `top3.json` curated payload), outputs (HTML + PDF + Drive URL). Mirrors the pattern of `meeting-deck-report/SKILL.md`.
- **build-deck.mjs** — vendored Chrome-headless + `gog` Drive logic. Layout is a NEWS deck (different from meeting deck): cover, summary slide, 3 detail slides, trend slide, CTA slide. Same dark theme + 繁中 typography (`PingFang TC`, `Noto Sans TC`).
- **CLI:** `node build-deck.mjs <top3-json-path> [--no-drive]`.

### 5.3 `ai-news-broadcast/` (orchestrator)

- **SKILL.md** — top-level skill. Triggers: scheduled (launchctl, every 2 days at 09:00) or manual (`/ai-news-broadcast`). Documents the env contract.
- **broadcast.mjs** — orchestrates: scrape → dedupe → rank → Haiku curate → translate → Haiku tips → deck → **archive** → **LINE bot push (8a)** **AND** **Personal LINE push (8b)** (parallel). Generates a UUID `run_id` per run for marker namespacing. Both 8a and 8b are first-class outputs: failure in one does not abort the other.
- **sources.json** — the editable account list (see §7).
- **personal-line-shim.mjs** — see §5.5 below; produces the JSON plan that the existing `personal-line-broadcast` Computer Use executor consumes, without forking the existing planner.
- **CLI:**
  ```
  node broadcast.mjs                              # full pipeline, last 48h window
  node broadcast.mjs --dry-run                    # scrape + curate + deck + archive, NO LINE push
  node broadcast.mjs --skip-scrape <posts.jsonl>  # rerun curation on cached scrape
  node broadcast.mjs --force                      # bypass idempotency
  node broadcast.mjs --bot-only                   # skip 8b (personal LINE), only 8a runs
  node broadcast.mjs --personal-only              # skip 8a (bot LINE), only 8b runs
  ```

### 5.4 `ai-news-archive/` (NEW in v0.2)

- **SKILL.md** — describes the archive contract: every successful run writes a Markdown doc; every doc is added to `INDEX.md`.
- **write-archive.mjs** — takes the curated `top3.json` + raw `posts.jsonl` summary + Drive PDF URL + run metadata, emits a single Markdown file at `archive/ai_news/<YYYY-MM-DD>_<HHmm>.md` and prepends a row to `archive/ai_news/INDEX.md`.
- **CLI:** `node write-archive.mjs <run_id> <top3-json> <posts-jsonl> <drive-url>`
- **Archive doc structure** (Markdown):
  ```markdown
  # AI 新聞廣播 · 2026-04-26 09:00
  
  - **Run ID:** `<uuid>`
  - **Window:** 2026-04-24 09:00 → 2026-04-26 09:00 (Taipei)
  - **Sources scraped:** 20 Facebook pages (Tier A 8 + Tier B 5 + Tier C 7)
  - **Total posts collected:** 247  →  after dedupe: 198  →  ranked top 30  →  curated top 3
  - **Deck PDF:** [drive.google.com/...](drive-link)
  - **LINE bot push:** ✓ Operator + 2 groups
  - **Personal LINE push:** ✓ 3 groups
  
  ## 本期 Top 3
  
  ### 1. <繁中 headline>
  - 來源:  [Meta AI on Facebook](post-url) · 2026-04-25 · 1.2k 讚
  - 摘要 (繁中):
    - …
    - …
    - …
  - **<YourChapter> 會員可以這樣用:**
    - ▸ …
    - ▸ …
  - **選擇理由:** <Haiku rationale>
  
  ### 2. <繁中 headline>
  …
  
  ### 3. <繁中 headline>
  …
  
  ## 趨勢觀察
  <one-paragraph meta-pattern>
  
  ## Raw scrape highlights (top 30 by rank, before Haiku curate)
  <table: rank | source | preview | score>
  
  ## Run log
  - scrape: 14.2s, $0.12
  - haiku curate: 3.1s, $0.005
  - haiku translate × 3: 4.8s, $0.005
  - haiku tips × 3: 4.2s, $0.005
  - chrome pdf: 2.8s
  - drive upload: 1.4s
  - line bot push: 0.9s
  - personal line: handed off to Claude Desktop at 09:01:32
  ```
- **INDEX.md format** (newest first):
  ```markdown
  # AI 新聞廣播 · 存檔
  
  | Date | Time | Top headline (繁中) | Sources | Deck | Doc |
  |---|---|---|---|---|---|
  | 2026-04-26 | 09:00 | OpenAI 發表新版 ... | 18 | [PDF](url) | [Open](2026-04-26_0900.md) |
  | 2026-04-24 | 09:00 | Anthropic Claude 5 ... | 18 | [PDF](url) | [Open](2026-04-24_0900.md) |
  ```

### 5.5 `personal-line-shim.mjs` — bridging to existing personal-LINE pipeline

- **Lives inside `ai-news-broadcast/`**, not `personal-line-broadcast/` (which we don't touch).
- **Plan mode:** reads our `top3.json` + `archive` URL + Drive PDF URL → emits JSON in the EXACT shape `personal-line-broadcast/broadcast.mjs` emits (`{skill: "personal-line-broadcast", runtime: "computer-use", date, runId (replaces botId), mode, payloadKind, targets, messages, markerPath, sendGapMs, instructions}`). The Claude Desktop executor — already trained to consume that schema — drives LINE.app identically.
- **Mark-done mode:** receives `[{target, ok, error?, messages: [{idx, ok}]}, …]` and writes `raw/ai_news/<date>/<run_id>.personal_line_done`. Same schema as the meeting-side marker, different path.
- **CLI:**
  ```
  node personal-line-shim.mjs <run_id> --plan        # emit JSON plan to stdout
  node personal-line-shim.mjs <run_id> --mark-done '<results-json>'
  ```
- **Why not modify the existing planner to accept news payloads?** No-touch rule. The shim is ~80 lines, matches the existing schema 1:1, and the executor (Claude Desktop) is the same code path on both sides.

---

## 6. Apify integration plan (v1: Facebook-only)

### Source platform

| Platform | Tool | Slug / endpoint | Pricing model | Auth |
|---|---|---|---|---|
| **Facebook** (only source in v1) | Apify | `apify/facebook-posts-scraper` | per-result; escalates with concurrency; may need residential proxies at scale | `APIFY_TOKEN` (+ optional Apify residential proxy add-on if Meta blocks) |

### Why Facebook-only for v1

- **X dropped:** the official X API Basic tier (~$100–$200/mo) is too expensive for the value vs FB-sourced AI news.
- **Threads dropped permanently (v0.5, 2026-04-26):** Per the original creator. Removed from non-goals as a deferral and from §3 Future as a re-enable target. Source pool is Facebook-only for the lifetime of this feature.
- Facebook gives us official-page coverage (OpenAI, Anthropic, Meta AI, NVIDIA AI, Hugging Face, etc.) AND 繁中 publisher pages (INSIDE 硬塞、數位時代、PanX etc.) on a single scraper — clean and focused.

### Estimated cost — per run AND per month

Cadence: **every 2 days** = ~15 runs/month (15.2 to be precise: 30.44 / 2).

| Step | Per-run | Per-month (× 15 runs) |
|---|---|---|
| Facebook scraping (Apify, ~15 pages × ~10 posts / 48hr) | ~$0.05–$0.10 | ~$0.75–$1.50 |
| Haiku curate × 1 | ~$0.005 | ~$0.075 |
| Haiku translate × 3 | ~$0.005 | ~$0.075 |
| Haiku tips × 3 | ~$0.005 | ~$0.075 |
| Chrome PDF, Drive upload, LINE pushes, archive write | $0 | $0 |
| **Per-run total** | **~$0.07–$0.12** | — |
| **Monthly total** | — | **~$1–$2 / month** |

> Apify's $5/mo free tier credit covers our usage — we may pay $0/mo in practice, depending on whether residential proxies are needed.

### Env vars (added to `~/.openclaw/secrets/bni-masta.env`)

```
APIFY_TOKEN=apify_api_xxx

# LINE bot channel (existing token reused; new var only for the news-specific group list)
BNI_AINEWS_LINE_GROUP_IDS=Cxxx...,Cyyy...

# Personal LINE targets (consumed by personal-line-shim.mjs; kept SEPARATE from the
# meeting-side BNI_PERSONAL_LINE_TARGETS so news + meeting target lists can differ)
BNI_AINEWS_PERSONAL_TARGETS=<YourChapter>好友群,<YourTestGroup>
BNI_AINEWS_PERSONAL_TEST_TARGETS=<YourTestGroup>
BNI_AINEWS_PERSONAL_MODE=test               # test|production

BNI_AINEWS_MODE=test                        # test|production (top-level orchestrator gate)
BNI_AINEWS_SOURCES_FILE=~/.openclaw/agents/bni-masta/agent/extensions/ai-news-broadcaster/skills/ai-news-broadcast/sources.json  # optional override (v0.4 path)
BNI_AINEWS_ARCHIVE_DIR=<vault-path>/archive/ai_news  # locked path (v0.3)
MAX_SCRAPE_COST_USD=0.50                    # safety cap for Apify per-run cost
```

> Threads-related env vars (e.g. `BNI_AINEWS_THREADS_ENABLED`) are intentionally absent. Threads was permanently dropped at v0.5 (2026-04-26).

---

## 7. Source accounts (v0.3 — Facebook-only, re-curated)

v0.3 fully replaces the v0.2 X-heavy list. Every source below is a **public Facebook page** scraped via Apify. Three tiers, ~17 pages total. The scraper pulls all enabled pages every run; rank+curate picks 30 → 3 from the combined feed.

### Tier A — AI lab / company official Facebook pages

These are the highest-signal sources for first-hand product launches and research announcements.

| # | Page name | FB handle / URL slug | Why | Signal | Freq | Lang |
|---|---|---|---|---|---|---|
| 1 | OpenAI | `OpenAI` | Official launches, model releases | High | 2-3×/wk | EN |
| 2 | Anthropic | `anthropic.ai` | Claude releases, safety research | High | Weekly | EN |
| 3 | Google AI | `googleai` (also Google DeepMind page) | Gemini, frontier research | High | 2-3×/wk | EN |
| 4 | Google DeepMind | `deepmind` | AlphaX, research papers | High | Weekly | EN |
| 5 | Meta AI | `MetaAI` | LLaMA family, generative releases (Meta is FB-native — most active here) | High | 3-4×/wk | EN |
| 6 | NVIDIA AI | `NVIDIAAI` | Hardware, CUDA, applied AI; bridges infra + apps | High | 2-3×/wk | EN |
| 7 | Microsoft AI | `MicrosoftAI` (or `Microsoft` AI-tagged posts) | Copilot, Azure AI, enterprise angle | Medium | Weekly | EN |
| 8 | Hugging Face | `huggingface` | Open-source model drops, community releases | Medium | 2-3×/wk | EN |

> **Verification step at install time:** for each handle above, hit `https://www.facebook.com/<handle>` once before adding to `sources.json` — confirm the page exists and posts in the last 30 days. Some major labs lean X-first and may have stale FB pages; flip `enabled: false` for any that turn out to be inactive. (Honest note: Meta-owned FB tends to favor Meta AI; non-Meta labs sometimes underinvest in FB.)

### Tier B — AI media / newsletter Facebook pages (English)

For breadth — these pages cross-post their AI articles, giving us third-party framing + business angle.

| # | Page name | FB handle / URL slug | Why | Signal | Freq | Lang |
|---|---|---|---|---|---|---|
| 9 | MIT Technology Review | `technologyreview` | Long-form AI analysis | Medium-High | Daily | EN |
| 10 | The Verge | `verge` (filter by AI tag at curate step) | Consumer-facing AI takes | Medium | Daily | EN |
| 11 | Wired | `wired` (AI-tagged) | Cultural + business angle | Medium | Daily | EN |
| 12 | VentureBeat | `VentureBeat` | Enterprise + funding + applied AI | Medium-High | Daily | EN |
| 13 | TechCrunch | `techcrunch` | Startup + product AI news | Medium | Daily | EN |

### Tier C — Traditional Chinese (繁中) Taiwan tech media Facebook pages

Per the v0.3 list. These are the strongest 繁中 signal we'll get on FB — major Taiwanese tech publishers that cover AI consistently.

| # | Page name (繁中) | FB handle / URL slug | Why | Signal | Freq | Lang |
|---|---|---|---|---|---|---|
| 14 | INSIDE 硬塞的網路趨勢觀察 | `insideAD` | TW tech media — AI is a major beat | High | Daily | 繁中 |
| 15 | 數位時代 BusinessNext | `bnextmedia` | Taiwan business + tech mag — strong AI coverage | High | Daily | 繁中 |
| 16 | PanX 泛科技 | `PanX.Asia` | TW tech commentary, AI-friendly | Medium | Few/wk | 繁中 |
| 17 | iThome | `ithome.online` | TW IT news, AI/cloud angle | Medium-High | Daily | 繁中 |
| 18 | T客邦 | `techbang` | Consumer tech + AI tools coverage | Medium | Daily | 繁中 |
| 19 | Mashdigi | `mashdigi` | TW tech news aggregator | Medium | Daily | 繁中 |
| 20 | AppWorks | `appworks.tw` | TW startup ecosystem; AI accelerator coverage | Medium | Few/wk | 繁中 |

> **Verification step at install time:** same drill — hit each FB page, confirm active in last 30 days, flip `enabled: false` on any stale ones.

### Final pool size

**~20 Facebook pages enabled by default** (8 Tier A + 5 Tier B + 7 Tier C). Above the "12-18" target requested, with the buffer being deliberate — install-time verification will probably retire 2-4 inactive/stale pages. Final live pool likely ~15-17.

### `sources.json` schema (v0.3, Facebook-only)

```jsonc
[
  // Tier A — AI lab / company official FB pages
  { "handle": "OpenAI",            "platform": "facebook", "weight": 1.5, "tier": "A", "lang": "en" },
  { "handle": "anthropic.ai",      "platform": "facebook", "weight": 1.5, "tier": "A", "lang": "en" },
  { "handle": "googleai",          "platform": "facebook", "weight": 1.4, "tier": "A", "lang": "en" },
  { "handle": "deepmind",          "platform": "facebook", "weight": 1.4, "tier": "A", "lang": "en" },
  { "handle": "MetaAI",            "platform": "facebook", "weight": 1.5, "tier": "A", "lang": "en" },
  { "handle": "NVIDIAAI",          "platform": "facebook", "weight": 1.3, "tier": "A", "lang": "en" },
  { "handle": "MicrosoftAI",       "platform": "facebook", "weight": 1.2, "tier": "A", "lang": "en" },
  { "handle": "huggingface",       "platform": "facebook", "weight": 1.2, "tier": "A", "lang": "en" },
  // Tier B — AI media / newsletter FB pages (EN)
  { "handle": "technologyreview",  "platform": "facebook", "weight": 1.2, "tier": "B", "lang": "en" },
  { "handle": "verge",             "platform": "facebook", "weight": 1.0, "tier": "B", "lang": "en", "ai_filter": true },
  { "handle": "wired",             "platform": "facebook", "weight": 1.0, "tier": "B", "lang": "en", "ai_filter": true },
  { "handle": "VentureBeat",       "platform": "facebook", "weight": 1.1, "tier": "B", "lang": "en" },
  { "handle": "techcrunch",        "platform": "facebook", "weight": 1.0, "tier": "B", "lang": "en", "ai_filter": true },
  // Tier C — 繁中 TW tech media FB pages
  { "handle": "insideAD",          "platform": "facebook", "weight": 1.5, "tier": "C", "lang": "zh-TW" },
  { "handle": "bnextmedia",        "platform": "facebook", "weight": 1.5, "tier": "C", "lang": "zh-TW" },
  { "handle": "PanX.Asia",         "platform": "facebook", "weight": 1.3, "tier": "C", "lang": "zh-TW" },
  { "handle": "ithome.online",     "platform": "facebook", "weight": 1.4, "tier": "C", "lang": "zh-TW" },
  { "handle": "techbang",          "platform": "facebook", "weight": 1.2, "tier": "C", "lang": "zh-TW" },
  { "handle": "mashdigi",          "platform": "facebook", "weight": 1.2, "tier": "C", "lang": "zh-TW" },
  { "handle": "appworks.tw",       "platform": "facebook", "weight": 1.1, "tier": "C", "lang": "zh-TW" }
]
```

Notes:

- `weight` multiplies the rank score. 繁中 sources get a small bonus (1.5/1.4) because the audience is zh-TW.
- `ai_filter: true` flags general-tech pages (Verge, Wired, TechCrunch) where the rank step should pre-filter posts to AI-related ones (heuristic: title/body matches `/AI|artificial intelligence|LLM|GPT|Claude|Gemini|machine learning/i`). Without this, those pages flood the candidate pool with non-AI tech news.
- `enabled` field omitted = `true` by default; set `false` to skip without removing.
- All FB handles are the slug after `facebook.com/`. Verify each at install time.

### Volume estimate

~20 FB pages × ~5–10 AI-relevant posts per 48hr = **~100–200 raw posts per run**. After AI-filter on general-tech pages + dedupe: ~80–150. Top-30 keep → 3 final. Comfortable headroom.

---

## 8. Content curation logic (how "top 3" is chosen)

### Stage 1 — heuristic rank (no LLM)

```
score(post) =
    log(1 + likes + 3*reposts + 2*replies)         # engagement (log-scaled to avoid one viral post dominating)
  + recency_bonus                                  # +1.0 if posted <24h ago, +0.5 <72h, 0 otherwise
  + source_weight                                  # from sources.json (default 1.0)
  + lang_match_bonus                               # +0.3 if post is zh-TW or zh-Hans
  - duplicate_penalty                              # -2.0 if dedupe collapses with another post
```

Keep top 30 by score; pass to Haiku.

### Stage 2 — Haiku curate

Prompt template (`prompts/curate-top3.md`, sketch):

```
你是 BNI <YourChapter> 分會的 AI 新聞編輯。以下是過去 7 天從各帳號擷取的 30 則
AI 相關貼文。請從中選出 **3 則最值得讓會員知道** 的新聞。

選擇標準：
1. 必須關於 AI 技術 / 產品 / 研究 / 政策（不要選 meme、推銷、純評論）。
2. 新穎 — 不是炒冷飯。
3. 對台灣中小企業主、創業者、業務、行銷人有實際參考價值。
4. 三則之間應該主題分散（避免三則都是同一家公司的事）。

對每則回傳：
{ "post_id": "...", "headline_zh": "30 字內中文標題", "rationale": "一句話為什麼選它" }

只輸出 JSON 陣列，不加任何說明。

<候選清單>
{posts_json}
</候選清單>
```

### Stage 3 — translate / summarize → zh-TW

For each chosen post, separate Haiku call:

```
將以下貼文翻譯成繁體中文，並摘要為：
- 1 行標題 (≤30 字)
- 3 行重點 (每行 ≤40 字)
保留原文連結與作者名。輸出 JSON。

<原文>
{post_text}
</原文>
```

### Stage 4 — duplicate-across-runs check

Maintain `raw/ai_news/_seen.jsonl` — a rolling log of `{post_id, picked_at, similarity_hash}` for the last 30 days. Before finalizing top-3, drop any candidate whose `post_id` matches a recent broadcast.

**v0.2 dedupe window: last 3 runs (≈ 6 days at every-2-day cadence).** This is short enough that genuinely fresh news always gets through, long enough that a story breaking on a Sunday isn't re-broadcast on Tuesday AND Thursday. Two layers of check:

1. **Exact `post_id` match** within last 3 runs → drop.
2. **Similarity-hash match** (SimHash of first 200 chars, lowercased + stripped) within last 3 runs → drop. Catches the case where the same news is posted by a different account (e.g. OpenAI announcement reposted by `_akhaliq`); the higher-engagement original wins, but the second telling is suppressed.

The `_seen.jsonl` is auto-pruned to last 30 days at end of each run.

---

## 9. Tips-for-<YourChapter>-members generation

Prompt sketch (`prompts/tips-for-huaai.md`):

```
你是 BNI <YourChapter> 分會的 AI 顧問，會員是台灣中小企業主、業務、保險、地產、
行銷、財顧、設計師等專業人士。基於以下 AI 新聞，為會員產生 1-2 條
**實用建議**。每條 ≤50 字，要具體（不要空話）。建議方向：

A. 商業應用 — 「這項技術可以怎麼用在你的業務上」
B. 趨勢談資 — 「下次跟客戶聊天可以怎麼提這個」
C. 學習行動 — 「這週可以花 15 分鐘做的事」

避免：
- 「擁抱 AI 浪潮」這類空話
- 假設會員已經會寫 prompt / API
- 推薦付費課程或產品（中性立場）

<新聞>
{news_summary}
</新聞>

輸出純文字，每條一行，前面加 ▸。
```

Output rendered on each top-3 detail slide as a "💡 <YourChapter> 會員可以這樣用" section.

---

## 10. Cadence & scheduling

### Locked default (v0.2)

**Every 2 days at 09:00 Taipei.** Rationale:

- 48-hour window is a sweet spot for AI news velocity — fresh enough that items still feel "new", long enough to catch weekend releases without forcing Mon/Tues bunching.
- Every-2-day cadence = 15 runs/month → predictable cost (~$1–$2/mo total for Apify + Haiku — see §6).
- Plays well with the dedupe window (last-3-runs ≈ 6 days; rare for the same story to surface 3x in 6 days).

### Alternatives considered (not chosen)

| Cadence | Pros | Cons |
|---|---|---|
| Daily 08:00 | Always-fresh | Noise risk; 2× the cost in Apify; harder dedupe |
| **Every 2 days 09:00 ✅ (chosen)** | Right velocity for SMB attention | — |
| Twice-weekly (Mon + Thu) | Predictable schedule | Same dedupe burden as daily |
| Weekly Mon | Lowest noise | Loses "newest" framing for mid-week breaks |
| Manual / on-demand | Operator controls | Defeats "continually" requirement |

### Implementation

A new `launchctl` plist (`com.bni-masta.ai-news-broadcast.plist`) installed under `~/Library/LaunchAgents/`. NOT modifying the existing `meeting-poll` LaunchAgent. Plist is created by an install script in this skill folder; uninstall = `launchctl unload` + `rm`.

Schedule expression: launchctl `StartCalendarInterval` with `Hour=9 Minute=0`, plus a small idempotency check inside `broadcast.mjs` that aborts if `archive/ai_news/<today>_*.md` already exists OR if the last successful run was <40 hours ago. (We don't bake "every 2nd day" into launchctl directly — running daily-with-skip is simpler and self-correcting if the machine is asleep on a "scheduled" day.)

### Personal LINE channel — Computer Use availability

The personal-LINE leg (8b) requires a live Claude Desktop session with Computer Use enabled at trigger time. **This is unchanged from how the existing post-meeting Pipeline #2 works** (see `personal-line-broadcast/SKILL.md`).

**v0.3 — confirmed: operator Mac is reliably on at 09:00 every other day.** Plan locks **Option 1: schedule the prompt inside Claude Desktop.** The Desktop session runs the orchestrator via slash-command `/ai-news-broadcast` on the cadence; the orchestrator drives both 8a (bot, fully scripted) and 8b (personal LINE, via Computer Use) in one session.

If 8b fails (Desktop wasn't running, LINE.app crashed, etc.): logged to the run marker as a per-target failure, but the bot channel (8a) and archive (7.5) still went out on time. No degraded-mode fallback wiring is built for v1 — The operator can re-trigger 8b manually with `node broadcast.mjs --personal-only --run-id <run_id>` if needed.

---

## 11. Open questions for the operator

**All blocking questions resolved as of v0.3 — proceed to implementation.**

The two non-blocking items below can be answered during implementation rather than gating it:

- **LINE group targets** — The operator provides the bot-channel group IDs (`BNI_AINEWS_LINE_GROUP_IDS`) and personal-LINE group names (`BNI_AINEWS_PERSONAL_TARGETS`) at install time, when the env file is being populated. Test mode runs with `<YourTestGroup>` only — no group IDs needed to start coding.
- **Apify account** — The operator either signs up for a free Apify account (covers our usage on free credit) OR provides an existing token at install time. Free tier is sufficient.

---

## 12. Verification / test plan

Before flipping `BNI_AINEWS_MODE=production`:

1. **Unit-level**
   - Scrape one FB page from each of Tier A / B / C via Apify standalone → confirm post structure + 繁中 handling.
   - Run dedupe + rank on a synthetic 30-post fixture → verify scoring sanity.
2. **Curate dry-run**
   - Hand-craft a 30-post JSONL → run Haiku curate → eyeball the top-3 + rationale.
   - Run translate prompt on 5 English posts → check zh-TW output quality.
   - Run tips prompt → verify they're concrete, not generic.
3. **Deck render**
   - Build deck from a hand-crafted top-3 → open the HTML in Chrome → click through → confirm zh-TW typography renders, no overflow.
   - Render PDF → confirm pages match slides.
4. **Drive upload**
   - Upload one test PDF → confirm anyone-reader link works in incognito.
5. **LINE bot push (test mode)**
   - `BNI_AINEWS_LINE_GROUP_IDS=` empty so only the operator's userId receives → push 2 messages → confirm formatting.
6. **Personal LINE (dry-run)**
   - `--dry-run` flag → planner emits literal "OK" payload to test target only → Claude Desktop drives LINE.app → confirm the OK lands in `<YourTestGroup>`.
7. **End-to-end test mode**
   - Real scrape, real curate, real deck, real Drive, but `BNI_AINEWS_MODE=test` so only test groups receive. The operator eyeballs the result.
8. **Production cutover**
   - Flip env to `production`. Watch the first run live. Have a kill switch: `launchctl unload com.bni-masta.ai-news-broadcast.plist` aborts future runs.

### Failure-mode coverage

- Apify actor 5xx → retry once, then skip that page and log; broadcast continues with remaining pages.
- Apify actor returns 0 posts for a page (page deleted/private/handle changed) → log + flag for `enabled: false` review on next manual sweep.
- Haiku 429 → retry with backoff; if still failing, abort run (do not broadcast a malformed deck).
- Chrome PDF empty → abort + alert.
- Drive upload fail → abort the LINE push (would be useless without the link), alert.
- One LINE target fails → continue others, record per-target result (matches existing pattern).

---

## 13. Appendix — files this plan does NOT touch

For completeness — verified list of existing files this work leaves alone (all 31 files under `bni-masta/` were sha256-checksummed at the Stage 1 scaffold step and re-verified after; no existing file was modified):

```
SOUL.md
skills/ingest-claude/{SKILL.md, compile.sh}
skills/member-upsert/{SKILL.md, upsert.mjs}
skills/transcribe-audio/{SKILL.md, transcribe.mjs}
skills/resolve-attendance/{SKILL.md, resolve.mjs}
skills/zoom-join/{SKILL.md, dispatch.mjs}
skills/pdf-ingest/{SKILL.md, ingest.mjs}
skills/roster-sync/{SKILL.md, sync.mjs}
skills/meeting-poll/{SKILL.md, poll.mjs}
skills/meeting-report/{SKILL.md, report.sh}
skills/attendance-to-sheet/{SKILL.md, update.mjs}
skills/post-meeting-digest/{SKILL.md, digest.mjs}
skills/post-meeting-line-digest/{SKILL.md, digest.mjs}
skills/detailed-meeting-report/{SKILL.md, detailed.mjs}
skills/meeting-deck-report/{SKILL.md, deck.mjs}
skills/personal-line-broadcast/{SKILL.md, broadcast.mjs}
```

**v0.4 widened the no-touch boundary:** the rule now applies to **every** path under `bni-masta/` that is NOT inside `extensions/ai-news-broadcaster/`. That includes any file added by the parent BNI Masta agent in the future, not just the 31 files frozen at scaffold time. The integration-surface contracts our extension depends on are enumerated in `MANIFEST.md` §5 (the contract surface) — if any of those move, please coordinate.

If anything in the implementation phase requires editing one of the above (or any other pre-existing file), **stop and surface it to the operator first** — that would violate the no-touch constraint.

---

## 14. Next step — implementation order

All blocking questions resolved. Implementation order:

1. Write `SKILL.md` files for all four new skill folders (`ai-news-broadcast`, `ai-news-scrape`, `ai-news-deck`, `ai-news-archive`).
2. Implement `ai-news-scrape/scrape.mjs` (Apify Facebook actor only). Test standalone against 2-3 FB pages from each tier; verify all ~20 handles in `sources.json` are live.
3. Implement `ai-news-deck/build-deck.mjs` against a fixture `top3.json`.
4. Implement `ai-news-archive/write-archive.mjs` against the same fixture.
5. Implement `ai-news-broadcast/broadcast.mjs` orchestrator + `personal-line-shim.mjs`. Test in `--dry-run` first, then `--bot-only`, then full.
6. Test mode end-to-end. Eyeball results in `<YourTestGroup>` group.
7. Production cutover: flip `BNI_AINEWS_MODE=production`, install launchctl plist.
8. Operate v1 in production. If FB-only signal proves thin, revisit the source pool (e.g. add more 繁中 Tier C pages, tighten Tier B AI-filter heuristics). **Threads is NOT a future channel — permanently dropped at v0.5; do not re-introduce it.**

Estimated implementation effort: ~1 focused day for v1 (Facebook-only is simpler than the v0.2 multi-platform plan).

---

## 15. Changelog

### v0.5 — 2026-04-26 (Stage 7 — Threads dropped permanently; install-ready prep)

- **Threads dropped permanently per the original creator 2026-04-26 — no longer planned for any future version.** Scrubbed every forward-looking Threads reference in active sections of the plan: §1 non-goals (now reads "permanently dropped" instead of "deferred to v1.1"), §3 folder-layout sidebar comment, §3 Future/v1.1 (the entire Threads bullet removed; renamed "Future / v1.1 — what we're keeping in our back pocket" to "Future — what we're keeping in our back pocket" since v1.1 no longer exists as a re-enable target), §4 data-flow box (the inline "[v1.1: Threads will be added here]" note replaced with a permanent-drop pointer), §5.1 (the v1.1 plan bullet removed), §5.4 archive-doc example (sources line updated to FB-only with concrete count), §6 (the v1.1 placeholder env var `BNI_AINEWS_THREADS_ENABLED` removed from the env block; absence of any Threads env var explicitly noted), §6 Why-FB-only callout (the Threads-deferral bullet rewritten as a permanent-drop bullet), §14 implementation-order step 8 (the "ship v1.1 with `BNI_AINEWS_THREADS_ENABLED=true`" promise replaced with a hard-stop note). Historical changelog entries (v0.1 / v0.2 / v0.3 / v0.4 below) are intentionally left intact — they document what was true at the time of writing; the v0.5 supersedure is recorded in this entry. **Hard stop for any future AI editor:** do not re-introduce a `"platform": "threads"` branch, a `BNI_AINEWS_THREADS_ENABLED` flag, or a Threads Apify actor pin to this plan or codebase without an explicit operator decision overturning v0.5.
- **Stage 7 install-ready prep landed alongside this change.** Specifically: `config/test-targets.json` (test-only target file consumed by the new `--test-targets` orchestrator flag), `scheduling/com.bni-masta.ai-news.plist` + `scheduling/install.sh` + `scheduling/uninstall.sh` (every-2-day 09:00 launchctl agent with the daily-with-state-file workaround for `StartCalendarInterval`'s lack of "every N days"), `INSTALL.md` (one-time install checklist), `tools/verify-sources.mjs` (HEAD-checks each FB page, flips `active: false` on dead ones, prints diff), and `test-results/stage7-dryrun.log` (full stdout of the two back-to-back full-chain `--dry-run` invocations proving end-to-end orchestrator dedupe). No design changes beyond the Threads drop above.
- Bumped to v0.5. Status line moved from "Stage 1 scaffolding complete" to "Stages 1–6 implemented; Stage 7 in progress."

### v0.4 — 2026-04-26 (Stage 1 scaffolding — layout consolidation)

Layout-only changes; design + content unchanged from v0.3.

- **Dedicated parent folder.** Everything this feature adds now lives under `extensions/ai-news-broadcaster/` (new top-level folder under `bni-masta/`). The `extensions/` parent signals "additive, not core" and gives any other AI working in this repo a single place to look. Triggered by the v0.4 request: "create a dedicated folder for the work you're about to do — another AI will also read what you're doing."
- **`MANIFEST.md` added** as the integration handoff document. Explicitly enumerates: what we read, what we modify (nothing), what we depend on (the contract surface), what env vars/system requirements we add, what we write to disk at runtime, how we're invoked, and explicit non-goals. Designed for another AI to read first before changing anything in the parent BNI Masta tree.
- **Skills nested one level deeper.** All four skill folders now live at `extensions/ai-news-broadcaster/skills/<name>/` instead of `bni-masta/skills/<name>/`. This is deliberate — the parent BNI Masta agent autoloads anything under `bni-masta/skills/`; nesting one level deeper guarantees our four skills are NOT autoloaded. The orchestrator invokes them by direct path. Updated §3 folder layout to reflect this.
- **Local `package.json` added** (`extensions/ai-news-broadcaster/package.json`) so any future npm dependencies stay scoped to this folder and never need to touch a parent package.json.
- **`plan.md` moved** from `skills/ai-news-broadcast/plan.md` into `extensions/ai-news-broadcaster/plan.md`. The old folder (`skills/ai-news-broadcast/`) is now empty and will be removed (workspace tooling permission permitting; otherwise flagged for manual cleanup).
- **No-touch rule widened.** §13 now applies to every file under `bni-masta/` outside `extensions/ai-news-broadcaster/`, not just the 31 files frozen at scaffold time. Re-verified by sha256-checksumming all 31 pre-existing files at Stage 1 — zero modifications.
- **§6 env var path updated.** `BNI_AINEWS_SOURCES_FILE` default path moved from the old skills-tree location to the new `extensions/ai-news-broadcaster/skills/ai-news-broadcast/sources.json` location.

No design changes. Source pool, cadence, prompts, cost model, dedupe strategy, archive format, LINE channel split, and v1.1 Threads roadmap all unchanged from v0.3.

### v0.3 — 2026-04-26 (FINAL — ready to implement)

Final round of decisions:

- **X channel REMOVED entirely.** Too expensive (X API Basic ~$100–$200/mo). All references to X / Twitter / `scrape_x.mjs` / `X_BEARER_TOKEN` / Twikit removed from data flow, components, source pool, env vars, cost table, and open questions.
- **Sources narrowed to Facebook-only for v1.** Threads is dropped from v1 and explicitly listed in §3 Future / v1.1 — Apify Threads actor wiring is preserved in design notes; re-enabling is a one-flag change (`BNI_AINEWS_THREADS_ENABLED=true`).
- **Source pool fully re-curated** to FB-resolvable accounts. v0.2's X-heavy 18-account list (Karpathy, AK, swyx, etc. — all X-native) replaced with **~20 Facebook pages across 3 tiers**:
  - Tier A — Lab/company official FB pages (8): OpenAI, Anthropic, Google AI, Google DeepMind, Meta AI, NVIDIA AI, Microsoft AI, Hugging Face
  - Tier B — AI media/newsletter FB pages (5): MIT Tech Review, The Verge, Wired, VentureBeat, TechCrunch (Verge/Wired/TechCrunch with `ai_filter: true` to drop non-AI tech posts)
  - Tier C — 繁中 TW tech media FB pages (7): INSIDE 硬塞、數位時代 BusinessNext、PanX 泛科技、iThome、T客邦、Mashdigi、AppWorks
  - Verification step at install time will likely retire 2-4 stale pages → final live pool ~15-17.
- **Translation flow bolded** in §1 with a dedicated callout block making it unmissable: source posts in (mostly English), all user-facing output in 繁體中文. Same callout in §4 step 5.
- **Archive location LOCKED:** `archive/ai_news/<YYYY-MM-DD>_<HHmm>.md` under the BNI vault root. Question 7 from v0.2 closed.
- **Archive audience LOCKED as private** for the operator. No URL in LINE messages. Question 10 from v0.2 closed; LINE message #3 just mentions the local archive path for the operator's reference.
- **Computer Use availability LOCKED:** operator Mac is reliably on at 09:00. Option 1 in §10 (single Desktop-driven run) is the only operational path; option 2 (degraded fallback with `personal_line_pending` markers) dropped from v1. Question 9 from v0.2 closed. Manual recovery via `--personal-only --run-id <id>` remains available if 8b fails.
- **Cost recomputed** to FB-only: ~$0.07–$0.12 per run × 15 runs/mo = **~$1–$2 per month total** (likely $0/mo on Apify's $5 free credit).
- **§11 collapsed** to a one-line resolution + 2 non-blocking install-time items (LINE group IDs, Apify token). All previous v0.2 open questions resolved.
- **Env vars cleaned up:** removed `X_BEARER_TOKEN` + all related X OAuth keys; removed `MAX_SCRAPE_COST_USD` X-flat-rate caveat; added v1.1 placeholder `BNI_AINEWS_THREADS_ENABLED` (commented out).
- **§14 implementation order** reduced from 7 to 7 steps with v0.2's parallel-platform complexity removed; effort estimate trimmed to ~1 focused day.

### v0.2 — 2026-04-26

Decisions applied to v0.1:

- **X scraping path:** switched from Twikit (throwaway-account scraping) to **official X API v2**. Added `scrape_x.mjs` component. Updated §6 with tier comparison + cost; X API Basic (~$100–$200/mo) now dominates the monthly cost line (~$102.50/mo total vs v0.1's ~$0.70/mo). New env vars `X_BEARER_TOKEN` (+ optional OAuth keys). Dropped all Twikit references.
- **Cadence:** changed from weekly Monday 09:00 to **every 2 days at 09:00**. Updated §10 (15 runs/mo) and §6 cost recomputation. Scrape window dropped from 7 days to 48 hours to match.
- **Approval gate:** **removed entirely.** Production runs are fully automated end-to-end. Updated §1 non-goals, §11 open Qs (dropped the gate question).
- **Content type:** explicitly clarified as **written-only** (PDF deck + LINE text + Markdown archive). No audio, no TTS. Updated §1 non-goals to call this out so the "voices" wording is unambiguous.
- **Content archive (NEW first-class component):** added `ai-news-archive/` skill folder + `archive/ai_news/<YYYY-MM-DD>_<HHmm>.md` doc per run + `archive/ai_news/INDEX.md` browseable index. Inserted as data-flow step 7.5. Component spec in new §5.4.
- **Personal LINE — elevated to first-class output channel.** v0.1 mentioned it but didn't give it equal billing with the bot channel. v0.2:
  - Added §5.5 (`personal-line-shim.mjs`) — a thin schema-matching planner that re-uses the existing Computer Use executor without forking the existing `personal-line-broadcast/broadcast.mjs`.
  - Rewrote §4 step 8 as a side-by-side block with 8a (bot) and 8b (personal) as parallel first-class outputs, both with per-target failure isolation, neither blocking the other.
  - Expanded §10 with the explicit Computer Use availability strategy (option 1 vs option 2).
  - Added `--bot-only` and `--personal-only` orchestrator flags so each channel can be tested or run in isolation.
  - New env vars `BNI_AINEWS_PERSONAL_TARGETS` / `BNI_AINEWS_PERSONAL_TEST_TARGETS` / `BNI_AINEWS_PERSONAL_MODE` (separate from the meeting-side personal-LINE config).
- **Source accounts expanded:** v0.1 had 8 verified + 2 TBD. v0.2 has **16 verified + 2 TBD = 18 total**, organized into Tiers A–E. New additions: `@ylecun`, `@goodfellow_ian`, `@swyx`, `@simonw`, `@LangChainAI`, `@GaryMarcus`, `@lennysan`, `@benthompson`. Volume estimate: ~240 raw posts/run, ~190 after dedupe.
- **Dedupe window:** changed from "14 days same `post_id`" to **"last 3 runs (~6 days), with both exact `post_id` AND SimHash similarity check"**. Aligns with the every-2-day cadence so a Sunday breaking story isn't re-broadcast Tuesday + Thursday.
- **Open questions:** dropped resolved ones; added Q3 (X API tier — biggest open cost decision), Q7 (Drive + archive folder location), Q9 (Computer Use availability strategy), Q10 (archive doc audience — private vs published).

### v0.1 — 2026-04-26

Initial plan covering 12 sections: goal, constraints, architecture, data flow, components, Apify integration (with Twikit for X), top-10 source accounts, curation logic, tips prompt, weekly cadence, 12 open questions, verification plan.
