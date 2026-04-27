---
name: ai-news-archive
description: Stage 4 of the AI News Broadcaster. Reads the Stage-2 scrape JSON, the Stage-3 `curated.json`, and the Stage-3 rendered `deck.pdf`, and writes a single browseable Markdown archive doc to `<vault-root>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.md`, copies the deck PDF next to it as `<YYYY-MM-DD>_<HHmm>.deck.pdf`, prepends a row to `<vault-root>/archive/ai_news/INDEX.md` (newest first), and writes a `<HHmm>.archive_done` idempotency marker. **INDEX.md is the only file this extension mutates-in-place anywhere.** Per-run files never overwrite — name collisions get a `_<n>` suffix. Pure stdlib (no new npm deps, no new env vars). Not auto-loaded by the parent BNI Masta agent (nested under `extensions/`).
metadata:
  openclaw:
    emoji: "🗂️"
    requires:
      env_optional: [BNI_VAULT_ROOT, BNI_VAULT_DIR, BNI_SECRETS_FILE]
      runtime: "node-18+"
    triggers:
      - "manual: node archive.mjs --scrape <scrape.json> --curated <curated.json> --deck <deck.pdf> [--vault-root <path>] [--dry-run]"
      - "orchestrator: invoked by ai-news-broadcast/broadcast.mjs (Stage 5) by direct path, AFTER the deck step and BEFORE the LINE pushes"
---

# ai-news-archive — Markdown archive + INDEX writer (Stage 4)

The archival leg of the AI News Broadcaster pipeline. Takes the three artifacts that already exist after Stages 2 & 3 — the deduped scrape JSON, the LLM-curated payload, and the rendered PDF deck — and turns them into one browseable Markdown record per run, plus a rolling index so the operator can scan past broadcasts at a glance.

This skill is intentionally narrow: it composes Markdown, copies the deck, prepends one row to the index, and writes a marker. **No scraping, no LLM calls, no LINE pushing, no Drive upload.** Those live in Stages 2, 3, 5.

## CLI

```bash
# Real run (writes archive .md + .deck.pdf + INDEX.md + marker)
node archive.mjs --scrape <scrape.json> --curated <curated.json> --deck <deck.pdf>

# Dry run — composes the markdown in memory, prints to stdout, touches no disk
node archive.mjs --scrape <scrape.json> --curated <curated.json> --deck <deck.pdf> --dry-run

# Override the vault root explicitly (otherwise uses env / convention)
node archive.mjs --scrape <scrape.json> --curated <curated.json> --deck <deck.pdf> \
                 --vault-root /tmp/ai-news-archive-test
```

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--scrape <path>` | (required) | The Stage-2 `<HHmm>_scrape.json`. Used for the run table at the bottom of the archive doc, the source-count line, and to derive `date`/`hhmm` so this stage's filenames line up with the scrape's. |
| `--curated <path>` | (required) | The Stage-3 `curated.json` — provides the top-N items + the 3 tips. |
| `--deck <path>` | (required) | The Stage-3 `deck.pdf`. **Copied** (not symlinked) into the archive folder next to the .md so the archive is self-contained. |
| `--vault-root <path>` | (resolved — see below) | Vault root under which `archive/ai_news/...` and `raw/ai_news/...` are created. |
| `--dry-run` | off | Compose the markdown in memory, print to stdout, do not touch disk. No vault required, no deck copy, no INDEX update, no marker. |

### Vault-root resolution order

1. `--vault-root` flag
2. `BNI_VAULT_ROOT` env
3. `BNI_VAULT_DIR` env (matches the `scrape.mjs` convention; mirrors the parent BNI Masta vault env name)
4. `<repo-path>/openclaw/vault` — only if it exists on this machine
5. `<vault-path>` — only if it exists on this machine

If none of those resolve, the run aborts with exit code 1 and a hint to set `BNI_VAULT_ROOT` or pass `--vault-root`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success — archive .md, deck pdf copy, INDEX.md, marker file all written (or, for `--dry-run`, markdown printed to stdout) |
| 1 | fatal error (input missing/malformed, deck not found, vault unresolvable, write failure, suffix > 99, ...) |
| 2 | bad CLI usage |

## Inputs

- **`scrape.json`** — Stage-2 output. Shape: see `../ai-news-scrape/SKILL.md`. We read `run.date`, `run.hhmm`, `sources[]`, `posts[]`.
- **`curated.json`** — Stage-3 output. Shape: see `../ai-news-deck/SKILL.md`. We read `items[]` (each with `headline_zhTW` / `summary_zhTW` / `why_it_matters_zhTW` / `source_url` / `posted_at` / `tier`) and `tips_zhTW[]`.
- **`deck.pdf`** — Stage-3 PDF. Copied byte-for-byte; we never re-render.
- **`~/.openclaw/secrets/bni-masta.env`** (optional) — only read for `BNI_VAULT_ROOT` / `BNI_VAULT_DIR`. No new secrets.

## Outputs

All paths under `<vault-root>/`:

| Path | When | What |
|---|---|---|
| `archive/ai_news/<YYYY-MM-DD>_<HHmm>.md` | Real runs | One Markdown doc per run. Self-contained — the file links to the deck PDF beside it via relative path. |
| `archive/ai_news/<YYYY-MM-DD>_<HHmm>.deck.pdf` | Real runs | Copy of the input `deck.pdf`. Same basename as the .md so a future cleanup can pair them. |
| `archive/ai_news/INDEX.md` | Real runs | Rolling index — created if absent, otherwise the new entry is **prepended** below the table divider so newest is first. **This is the only file in the entire extension that we mutate-in-place; everywhere else we are append-only or new-file-only.** |
| `raw/ai_news/<YYYY-MM-DD>/<HHmm>.archive_done` | Real runs | Idempotency marker mirroring the `scrape_done` convention. JSON body records `run_id`, archive paths, suffix used, item count, source/post counts. |

### Collision handling

Per-run files **never overwrite**. If `<date>_<hhmm>.md` or `<date>_<hhmm>.deck.pdf` already exists, the run uses suffix `_2`, then `_3`, ... up to `_99`. The .md and .deck.pdf always share the same suffix so they stay paired. The marker records the suffix that was used so the orchestrator can re-derive the actual paths.

INDEX.md is the only intentionally-mutated file. The new row is inserted right below the markdown-table divider line; the rest of the file (header, blurb, prior rows) is preserved verbatim.

### Stdout — single OK line (real runs)

```
[ai-news-archive] OK — archive: <md path>, deck: <pdf path>, index updated
```

### Stdout — full markdown body (`--dry-run`)

The complete archive .md body is written to stdout. No other text. No file writes. Useful for previewing template changes without touching the vault.

## Markdown structure

```markdown
# AI 趨勢快訊 — YYYY/MM/DD HH:mm

- **Run timestamp:** <ISO-8601>
- **Sources scanned:** N pages, K posts after dedupe
- **Top picks:** 3
- **Deck PDF:** [<basename>.deck.pdf](<basename>.deck.pdf)
- **Generated by:** ai-news-broadcaster v0.4

---

## 精選三則 (繁體中文)

### 1. <headline_zhTW>
- **來源：** <author> · [原文連結](<source_url>) · <posted-date>
- **Tier：** <A/B/C>
- **摘要：** <summary_zhTW>
- **為什麼重要：** <why_it_matters_zhTW>

### 2. ...
### 3. ...

---

## 給<YourChapter> 夥伴的 Tips
1. <tip 1>
2. <tip 2>
3. <tip 3>

---

## 完整掃描清單 (raw)

| # | Source | Author | Posted | Engagement | Link |
|---|--------|--------|--------|------------|------|
| ... full table of every post in the scrape, sorted by posted_at desc |

---

## Run metadata
- **Apify actor:** apify/facebook-posts-scraper
- **Scrape window:** last 48h
- **Dedupe window:** prior 3 runs
- **Curation model:** claude-haiku-4-5-20251001
- **Run ID:** <YYYYMMDD_HHmm>
- **Sources reachable:** <ok>/<total>
```

## Vendored from existing skills (NOT imported)

| Pattern | Source | Purpose |
|---|---|---|
| `loadEnvFile()` | `skills/meeting-deck-report/deck.mjs:19-26` (also `skills/post-meeting-line-digest/digest.mjs`) | Tiny `KEY=VALUE` env-file loader — same pattern as Stages 2/3 |
| Vault-root env name `BNI_VAULT_DIR` | `skills/meeting-deck-report/deck.mjs` (and `scrape.mjs` Stage 2) | Reused as a resolution fallback so news + meeting features see the same root by default |

No imports. No edits to any pre-existing skill.

## Dependencies

- Node 18+ (stdlib only — no new npm packages added at this stage)
- No new env vars (`BNI_VAULT_ROOT` is recognized but never required if `BNI_VAULT_DIR` or one of the convention paths exists)
- No system requirements beyond Node

## Reads / writes summary

| Path | R/W | When |
|---|---|---|
| `<--scrape>` | read | every run |
| `<--curated>` | read | every run |
| `<--deck>` | read (then copyFileSync) | every run (real); only read for shape check on `--dry-run` (path must still exist) |
| `~/.openclaw/secrets/bni-masta.env` | read | every run (env loader) |
| `<vault>/archive/ai_news/<date>_<hhmm>.md` | write (no overwrite — suffix on collision) | real runs |
| `<vault>/archive/ai_news/<date>_<hhmm>.deck.pdf` | write (copy from `--deck`) | real runs |
| `<vault>/archive/ai_news/INDEX.md` | **mutate-in-place** (prepend new row below divider, preserve rest) | real runs |
| `<vault>/raw/ai_news/<date>/<hhmm>.archive_done` | write | real runs |

## What this skill does NOT do

- No scraping. That's Stage 2 (`ai-news-scrape`).
- No LLM curation, no PDF rendering. That's Stage 3 (`ai-news-deck`).
- No LINE push, no Drive upload. That's Stage 5 (`ai-news-broadcast` orchestrator).
- No SimHash similarity dedupe — Stage 2 already did exact-id dedupe.
- No edits to any file outside `<vault-root>/archive/ai_news/`, `<vault-root>/raw/ai_news/`, or this extension folder.
- No new env vars, no new npm packages.
