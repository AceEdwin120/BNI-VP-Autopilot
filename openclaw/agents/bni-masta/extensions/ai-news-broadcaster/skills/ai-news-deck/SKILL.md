---
name: ai-news-deck
description: Stage 3 of the AI News Broadcaster. Reads a Stage-2 scrape JSON, heuristically pre-ranks the deduped posts (recency × engagement × source-tier weight), then asks Claude Haiku in **one** call to pick the top 3 most important items + write Traditional Chinese (zh-TW) summaries + generate 3 actionable tips for <YourChapter> BNI Masta members. Renders a 6-page slide deck to `deck.html` and (when not `--dry-run`) `deck.pdf` via vendored Chrome-headless. Also writes `curated.json` for the Stage-4 archive. Local-scoped npm dependency on `@anthropic-ai/sdk`. Not auto-loaded by the parent BNI Masta agent (nested under `extensions/`).
metadata:
  openclaw:
    emoji: "🗞️"
    requires:
      env: [ANTHROPIC_API_KEY]
      env_optional: [BNI_AINEWS_SOURCES_FILE, BNI_SECRETS_FILE]
      runtime: "node-18+"
      packages: ["@anthropic-ai/sdk"]
      system: ["Google Chrome (headless render, macOS path)"]
    triggers:
      - "manual: node deck.mjs --input <scrape.json> --out-dir <dir> [--dry-run] [--top-n 3] [--no-render]"
      - "orchestrator: invoked by ai-news-broadcast/broadcast.mjs (Stage 5) by direct path"
---

# ai-news-deck — curate + 繁中 translate + render PDF deck (Stage 3)

The deck-building leg of the AI News Broadcaster pipeline. Takes the deduped Stage-2 scrape JSON and produces a presentable 6-slide PDF (`deck.pdf`) + the LLM-curated payload (`curated.json`) the Stage-4 archive will consume.

This skill is intentionally narrow: it ranks, curates (one Anthropic call), and renders. **No LINE pushing, no Drive upload, no Markdown archive.** Those are Stage 4 / Stage 5.

## CLI

```bash
node deck.mjs --input <scrape.json> --out-dir <dir>            # full run
node deck.mjs --input <fixture.json> --out-dir /tmp/out --dry-run
node deck.mjs --input <scrape.json>  --out-dir <dir> --no-render  # HTML only, skip Chrome PDF
node deck.mjs --input <scrape.json>  --out-dir <dir> --top-n 5    # pick top 5 instead of 3
```

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--input <path>` | (required) | The Stage-2 `*_scrape.json` file. Accepts both the wrapped `{schema_version, run, sources, posts}` shape and a bare `[posts]` array. |
| `--out-dir <dir>` | (required) | Directory where `deck.html`, `curated.json`, and (unless skipped) `deck.pdf` are written. Created if missing. |
| `--dry-run` | off | Skip the Anthropic call (use a hard-coded sample top-N + tips fixture) AND skip the Chrome PDF render. Still writes `deck.html` and `curated.json`. Lets you exercise the file-IO + template path without an API key. |
| `--top-n <n>` | `3` | How many items to keep from the top-15 ranked candidates. The slide template scales (1 slide per item). |
| `--no-render` | off | Skip the Chrome PDF render, write only `deck.html` and `curated.json`. (The Anthropic call still runs unless combined with `--dry-run`.) |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success — outputs written, 1-line summary on stdout |
| 1 | fatal error (no `ANTHROPIC_API_KEY` for live runs, input missing/malformed, all-empty-text posts, Chrome render failure, ...) |
| 2 | bad CLI usage |

## Inputs

- **Stage-2 scrape JSON** at `--input` — whatever `ai-news-scrape/scrape.mjs` wrote. Shape: see `../ai-news-scrape/SKILL.md`.
- **`config/sources.json`** (relative to extension root) — read for tier weights. If unreadable, every source defaults to tier B.
- **`ANTHROPIC_API_KEY`** env (required for live runs, not for `--dry-run`). Loaded from `~/.openclaw/secrets/bni-masta.env` via the same `loadEnvFile` pattern used elsewhere in this repo.
- **`BNI_AINEWS_SOURCES_FILE`** env (optional) — overrides the default sources path.
- **`BNI_SECRETS_FILE`** env (optional) — overrides the default secrets file path.

## Outputs

All under `<out-dir>/`:

| File | When | What |
|---|---|---|
| `deck.html` | Always | The source HTML before PDF render — kept for debugging / quick eyeball. |
| `deck.pdf` | Live runs (not `--dry-run` and not `--no-render`) | The 6-page deliverable rendered via Chrome headless. |
| `curated.json` | Always | The LLM output payload (`items` + `tips_zhTW`) plus run metadata. **This is the input to the Stage-4 archive.** |

### `curated.json` schema

```jsonc
{
  "schema_version": 1,
  "run": {
    "date": "2026-04-26",
    "generated_at": "2026-04-26T01:00:00.000Z",
    "input": "<absolute path to scrape.json>",
    "candidates_in": 87,
    "candidates_ranked": 15,
    "top_n": 3,
    "anthropic_model": "claude-haiku-4-5-20251001",
    "dry_run": false
  },
  "items": [
    {
      "id": "<post id from Stage 2>",
      "headline_zhTW": "≤30 字繁中標題",
      "summary_zhTW": "2-3 句繁中摘要",
      "why_it_matters_zhTW": "一句話為什麼這對<YourChapter> 重要",
      "source_url": "https://www.facebook.com/...",
      "posted_at": "2026-04-25T08:00:00.000Z",
      "tier": "A"
    }
  ],
  "tips_zhTW": [
    "本週花 15 分鐘體驗一個你還沒用過的 AI 工具，記下三個能用在自己業務上的場景。",
    "下次跟客戶聊天時挑一則本期新聞當開場話題，觀察客戶反應做為趨勢試水溫。",
    "把本期 deck 轉發給一位你覺得會有共鳴的會員，邀請對方下次分會聚會時一起討論。"
  ]
}
```

### Stdout — single OK line

```
[ai-news-deck] OK — top 3 from 87 candidates, deck: <path>, pages: 6
```

## Pipeline

1. **Load** the scrape JSON (accepts wrapped or bare-array shape).
2. **Heuristic pre-rank** every post:
   - `engagement_score = log10(1 + likes + 2*comments + 3*shares)`
   - `recency = max(0, 1 − age_hours / 72)` — linear decay 0..72h
   - `tier_weight` from `config/sources.json`: A=1.0, B=0.7, C=0.85 (繁中 bumped because the audience is zh-TW)
   - Drop posts with empty `text`. Keep top **15** candidates.
3. **One Anthropic call** (`claude-haiku-4-5-20251001`) — picks the top N, writes 繁中 headline / summary / why_it_matters per item, and produces 3 actionable tips. The prompt:
   - Caps each candidate's text at 1500 chars.
   - Asks for strict JSON (no markdown fences) and parses defensively.
   - Asks for **繁體 only** (no 簡體) and Taiwanese tech vocabulary.
   - Biases toward novelty over hype, asks for topic-diverse top 3, avoids meme/ad/empty-rationale items.
4. **Render** the deck:
   - **Slide 1** — Cover: 「AI 趨勢快訊 — YYYY/MM/DD」 + 「<YourChapter> · BNI Masta」 + run timestamp footer
   - **Slides 2..(N+1)** — One per item: numbered head + tier badge, large 繁中 headline, summary, why-it-matters callout, source link footer
   - **Slide (N+2)** — 「給<YourChapter> 夥伴的 3 個 tips」 — numbered list view
   - **Slide (N+3)** — Back-cover: all source URLs (so the audience can dig deeper)
   - Sans-serif zh-TW typography (`Noto Sans TC` → `PingFang TC` → `Microsoft JhengHei` → system fallback).
5. **Chrome-headless PDF** — pattern vendored from `skills/meeting-deck-report/deck.mjs` lines 14, 427-435. Same `--print-to-pdf` flags. Render skipped when `--dry-run` or `--no-render`.

## Vendored from existing skills (NOT imported)

Per the no-touch rule + MANIFEST policy, `deck.mjs` does not import from any pre-existing skill. It vendors:

| Pattern | Source | Lines | Purpose |
|---|---|---|---|
| `loadEnvFile()` | `skills/meeting-deck-report/deck.mjs` and `skills/post-meeting-line-digest/digest.mjs` | meeting-deck-report `19-26` | Tiny `KEY=VALUE` env-file loader |
| `CHROME` const + `spawnSync` invocation | `skills/meeting-deck-report/deck.mjs` | `14`, `427-435` | Chrome-headless `--print-to-pdf` render of an HTML file to PDF |

Each vendored function has a comment block above it pointing to the source. We do **not** vendor the `gog drive upload/share` or LINE-push patterns — those are Stage 5's concern.

## Cost

Per plan §6:

- One Haiku call per run (combined curate + translate + tips) on `claude-haiku-4-5-20251001` — typically <$0.01/run with the prompt sized at ~15 candidates × ~1500 chars each.
- `--dry-run` is free.

## Reads / writes summary

| Path | Read/Write | When |
|---|---|---|
| `<--input>` (Stage-2 `*_scrape.json`) | read | every run |
| `extensions/ai-news-broadcaster/config/sources.json` | read | every run (tier lookup) |
| `~/.openclaw/secrets/bni-masta.env` | read | every run (env loader) |
| `<--out-dir>/deck.html` | write | every run |
| `<--out-dir>/curated.json` | write | every run |
| `<--out-dir>/deck.pdf` | write | when not `--dry-run` and not `--no-render` |
| Anthropic Messages API | network | every run, except `--dry-run` |
| `/Applications/Google Chrome.app/...` | exec (spawnSync) | when not `--dry-run` and not `--no-render` |

## What this skill does NOT do

- No scraping. That's Stage 2 (`ai-news-scrape`).
- No Markdown archive write or `INDEX.md` update. That's Stage 4 (`ai-news-archive`).
- No LINE push, no Google Drive upload. Stage 5 wraps those (Drive upload pattern is vendored there, not here, since the bot/personal-LINE legs need the Drive URL too).
- No SimHash dedupe — Stage 2 already did exact-id dedupe; SimHash similarity is a Stage 5 responsibility per plan §8.
- No idempotency marker writes. The orchestrator (Stage 5) writes the per-run markers; this script is a pure transform.
