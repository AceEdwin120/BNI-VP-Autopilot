---
name: ai-news-scrape
description: Stage 2 of the AI News Broadcaster. Reads `extensions/ai-news-broadcaster/config/sources.json`, calls Apify's `apify/facebook-posts-scraper` actor for each active Facebook source over a configurable look-back window (default 48h), normalizes results into a unified post shape, dedupes against the prior 3 daily runs, and writes the deduped output to `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>_scrape.json` with an idempotency marker. Per-source try/catch — one bad source does not abort the run. Local-scoped npm dependency on `apify-client`. Not auto-loaded by the parent BNI Masta agent (nested under `extensions/`).
metadata:
  openclaw:
    emoji: "📰"
    requires:
      env: [APIFY_TOKEN]
      env_optional: [BNI_VAULT_DIR, BNI_AINEWS_SOURCES_FILE, BNI_SECRETS_FILE]
      runtime: "node-18+"
      packages: [apify-client]
    triggers:
      - "manual: node scrape.mjs [--dry-run] [--source <id>] [--since-hours <n>] [--per-page-limit <n>] [--out <path>] [--no-dedupe]"
      - "orchestrator: invoked by ai-news-broadcast/broadcast.mjs (Stage 5) by direct path"
---

# ai-news-scrape — Apify Facebook scraper (Stage 2)

The scraping leg of the AI News Broadcaster pipeline. Pulls recent posts from a curated set of Facebook pages (AI labs, AI media, 繁中 TW tech publishers — see `../../config/sources.json`) and emits a single normalized JSON file per run.

This skill is intentionally narrow: it scrapes, normalizes, and dedupes. **No ranking, no LLM calls, no broadcasting.** The Stage 5 orchestrator (`ai-news-broadcast/broadcast.mjs`, separate stage) will rank → curate → translate → push downstream.

## CLI

```bash
node scrape.mjs                          # full run, all active sources, last 48h
node scrape.mjs --dry-run                # emit fixture without calling Apify
node scrape.mjs --source openai-fb       # restrict to a single source (testing)
node scrape.mjs --since-hours 24         # narrow the window (default 48)
node scrape.mjs --per-page-limit 10      # cap posts per page (default 25)
node scrape.mjs --out /tmp/scrape.json   # override output path
node scrape.mjs --no-dedupe              # skip prior-3-runs id dedupe
node scrape.mjs --sources /alt/file.json # override sources.json path
```

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--dry-run` | off | Skip Apify entirely; emit a deterministic 2-post fixture per source. Lets you exercise normalization, dedupe, and write paths without an `APIFY_TOKEN`. |
| `--source <id>` | all | Restrict the run to a single source by `id` from `sources.json`. Source must still be `active: true` and `platform: "facebook"`. |
| `--since-hours <n>` | `48` | Look-back window. Posts older than this (per `posted_at`) are filtered out. |
| `--per-page-limit <n>` | `25` | Max posts per page passed to the actor input AND a hard cap applied to dry-run fixtures. |
| `--out <path>` | `<vault>/raw/ai_news/<date>/<hhmm>_scrape.json` | Override the output JSON path. The idempotency marker still lands next to the default location. |
| `--no-dedupe` | off | Skip the prior-3-runs id dedupe. Useful when refilling a missed window manually. |
| `--sources <path>` | `../../config/sources.json` | Override the sources.json path (also via env `BNI_AINEWS_SOURCES_FILE`). |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success — output and marker written, 1-line summary on stdout |
| 1 | fatal error (no `APIFY_TOKEN` for live runs, sources file missing/malformed, write failure, no matching active sources, ...) |
| 2 | bad CLI usage |

## Inputs

- **`config/sources.json`** (relative to extension root) — the source pool. Filtered to `active: true && platform: "facebook"` before scraping. See plan.md §7 for tier definitions.
- **`APIFY_TOKEN`** env (required for live runs, not for `--dry-run`). Read from `~/.openclaw/secrets/bni-masta.env` via the same loader pattern used by `skills/personal-line-broadcast/broadcast.mjs`.
- **`BNI_VAULT_DIR`** env (optional) — overrides the default vault root `<vault-path>`.
- **`BNI_AINEWS_SOURCES_FILE`** env (optional) — overrides the default sources path.
- **`BNI_SECRETS_FILE`** env (optional) — overrides the default secrets file path.

## Outputs

### Run JSON — `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>_scrape.json`

```jsonc
{
  "schema_version": 1,
  "run": {
    "date": "2026-04-26",
    "hhmm": "0900",
    "timezone": "Asia/Taipei",
    "since_hours": 48,
    "per_page_limit": 25,
    "dry_run": false,
    "no_dedupe": false,
    "apify_actor": "apify/facebook-posts-scraper",
    "generated_at": "2026-04-26T01:00:00.000Z"
  },
  "sources": [
    { "source_id": "openai-fb", "raw": 12, "kept": 12, "ok": true },
    { "source_id": "metaai-fb", "raw": 0,  "kept": 0,  "ok": false, "error": "actor 5xx" }
  ],
  "posts": [
    {
      "id": "<sha256-12 of post_url>",
      "source_id": "openai-fb",
      "platform": "facebook",
      "post_url": "https://www.facebook.com/OpenAI/posts/...",
      "author": "OpenAI",
      "posted_at": "2026-04-25T08:00:00.000Z",
      "text": "...",
      "image_urls": ["..."],
      "engagement": { "likes": 1234, "comments": 56, "shares": 78 },
      "scraped_at": "2026-04-26T01:00:00.000Z"
    }
  ]
}
```

### Idempotency marker — `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>.scrape_done`

```jsonc
{
  "done": true,
  "at": "2026-04-26T01:00:00.000Z",
  "post_count": 87,
  "source_count": 20,
  "dropped_duplicates": 4,
  "dry_run": false,
  "output": "<vault-path>/raw/ai_news/2026-04-26/0900_scrape.json"
}
```

The marker is intentionally separate from the run JSON so the orchestrator (Stage 5) can quickly check "did the scrape succeed for this slot?" without reading the full posts list.

### Stdout — single OK line

```
[ai-news-scrape] OK — 87 posts from 20 sources, 4 duplicates dropped, output: <path>
```

## Dedupe semantics

Post `id` = first 12 hex chars of `sha256(post_url)`. Stable across runs.

The dedupe step reads up to the **3 most recent prior daily folders** under `<vault>/raw/ai_news/` (lexicographic sort, capped at 3, excluding the current date), opens any `*scrape*.json` it finds, collects every `posts[].id`, and drops matching ids from the current run. Falls back gracefully when:

- the raw root doesn't exist yet (first-ever run) → no dedupe, all posts pass
- a prior run file is malformed → that file is skipped, others still contribute
- `--no-dedupe` is set → the entire step is bypassed

This satisfies plan §8 stage 4 ("dedupe window: last 3 runs ≈ 6 days at every-2-day cadence"). The full SimHash similarity layer in plan §8 is **deferred to the Stage 5 orchestrator's curate step** — `scrape.mjs` only does exact-id dedupe, which is what's needed at this layer.

## Per-source failure isolation

Each source is wrapped in a try/catch. On error, the run records `{ source_id, raw: 0, kept: 0, ok: false, error: "..." }` in the `sources` array and continues. The exit code is still `0` if any source returned data; only fatal pre-flight errors (missing token, missing sources file, etc.) abort the run.

## Apify actor

Pinned to `apify/facebook-posts-scraper` (the official Apify-maintained Facebook posts actor). Input passed:

```jsonc
{
  "startUrls": [{ "url": "https://www.facebook.com/<page_handle>" }],
  "resultsLimit": 25,
  "maxPosts": 25,
  "onlyPostsNewerThan": "<ISO since-cutoff>"
}
```

Field-name superset is used because the actor has tweaked its input keys across versions; unknown keys are ignored. Output is normalized defensively — see `pick(obj, [...keys])` in `scrape.mjs` for the field aliases tried.

## Dependencies

- Node 18+ (uses native `fetch` ergonomics indirectly via `apify-client`; ESM module syntax)
- `apify-client@^2.23.0` — installed locally via `extensions/ai-news-broadcaster/package.json`. Not in any parent `package.json`.

## Cost

Per plan §6: ~$0.05–$0.10/run on Apify, well under the `MAX_SCRAPE_COST_USD=0.50` ceiling. `--dry-run` is free.

## Reads / writes summary

| Path | Read/Write | When |
|---|---|---|
| `extensions/ai-news-broadcaster/config/sources.json` | read | every run |
| `~/.openclaw/secrets/bni-masta.env` | read | every run (env loader) |
| `<vault>/raw/ai_news/<prior 3 dates>/*scrape*.json` | read | dedupe, when not `--no-dedupe` |
| `<vault>/raw/ai_news/<today>/<HHmm>_scrape.json` | write | every run |
| `<vault>/raw/ai_news/<today>/<HHmm>.scrape_done` | write | every run |
| Apify REST endpoints | network | every run, except `--dry-run` |

## What this skill does NOT do

- No ranking, scoring, or curation. That's Stage 5.
- No LLM calls. That's Stage 5.
- No SimHash similarity dedupe — only exact-id. SimHash is Stage 5 (curate step).
- No Threads or X scraping. Both are permanently out: X dropped (cost), Threads permanently dropped at plan v0.5 (2026-04-26) — see `../../plan.md` §3 / §6 / §15.
- No deck building, no LINE pushing, no archiving. Separate skills (Stages 3, 4, 5).
