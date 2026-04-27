# ai-news-broadcast

Top-level orchestrator for the AI News Broadcaster feature (Stage 6 of 8).

End-to-end pipeline: scrape ~20 public Facebook AI sources → curate top 3 +
translate to 繁中 + generate <YourChapter> 夥伴 tips → render a 6-page PDF deck →
write a Markdown archive doc + update INDEX → fan out the result to two LINE
channels in parallel (BNI Masta bot account + the operator's personal LINE).

## In-process composition (no subprocess spawn)

The orchestrator imports the three sub-skill modules and calls their exported
`runScrape(opts)` / `runDeck(opts)` / `runArchive(opts)` functions directly in
a single Node process. There is **no** subprocess spawn, no stdout parsing,
no string-marshalling of CLI flags between layers. The `dryRun` flag cascades
by being passed straight into each step's options object.

The three sub-skills are still independently runnable for debugging
(`node scrape.mjs --dry-run`, `node deck.mjs --input ...`, etc.). Their CLI
behavior — including the `[ai-news-X] OK — ...` summary lines — is unchanged
from Stages 2/3/4. The `import.meta.url` guard at the bottom of each file
keeps the CLI `main()` from auto-firing when imported by this orchestrator.

## Inputs

- **Env vars only.** No CLI input files — the orchestrator generates every
  intermediate artifact itself from the standard env contract.
- Required (live runs): `APIFY_TOKEN`, `ANTHROPIC_API_KEY`,
  `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_TARGET_GROUP_IDS`,
  `LINE_PERSONAL_TARGET_GROUPS` (Stage 6).
- Optional: `BNI_VAULT_ROOT` / `BNI_VAULT_DIR` (vault root override),
  `BNI_AINEWS_SOURCES_FILE` (sources.json override),
  `BNI_SECRETS_FILE` (env file override),
  `BNI_AINEWS_PERSONAL_MODE` (test|production; default test),
  `BNI_AINEWS_PERSONAL_DELAY_MS` (between-message delay, default 1500).

`LINE_CHANNEL_ACCESS_TOKEN` and `LINE_TARGET_GROUP_IDS` are NEW in Stage 5.
Format:

```
LINE_CHANNEL_ACCESS_TOKEN=<long-lived channel access token>
LINE_TARGET_GROUP_IDS=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,Cyyyyyyyy...
```

`LINE_TARGET_GROUP_IDS` is a comma-separated list of LINE group IDs (each one
is `C` + 32 hex chars) where the BNI Masta OA bot is installed. Empty/unset
is allowed in dry-run; live mode with an empty list logs a no-op.

## Outputs (per run)

Live run produces:

| Path | Written by |
|------|------------|
| `<vault>/raw/ai_news/<date>/<hhmm>_scrape.json`     | `runScrape` |
| `<vault>/raw/ai_news/<date>/<hhmm>.scrape_done`     | `runScrape` |
| `<vault>/build/ai_news/<run_id>/deck.html`          | `runDeck` (kept on `--keep-temp`) |
| `<vault>/build/ai_news/<run_id>/deck.pdf`           | `runDeck` (kept on `--keep-temp`) |
| `<vault>/build/ai_news/<run_id>/curated.json`       | `runDeck` (kept on `--keep-temp`) |
| `<vault>/archive/ai_news/<date>_<hhmm>.md`          | `runArchive` |
| `<vault>/archive/ai_news/<date>_<hhmm>.deck.pdf`    | `runArchive` |
| `<vault>/archive/ai_news/INDEX.md`                  | `runArchive` (mutated in place) |
| `<vault>/raw/ai_news/<date>/<hhmm>.archive_done`    | `runArchive` |
| LINE messages pushed to `LINE_TARGET_GROUP_IDS`     | bot LINE channel (this file) |
| `<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json` | `runPersonalLine` (Stage 6) |
| `<vault>/raw/ai_news/<date>/<run_id>.personal_line_done`      | Claude Desktop executor (async) |

By default the orchestrator deletes `<vault>/build/ai_news/<run_id>/` after a
successful run; `raw/` and `archive/` are preserved. Pass `--keep-temp` to
keep `build/` for debugging.

## CLI

```
node broadcast.mjs                                # full pipeline, live
node broadcast.mjs --dry-run                      # cascade dryRun:true into
                                                  #   all sub-skills, skip LINE
                                                  #   push, log message body
node broadcast.mjs --bot-only                     # skip personal-LINE leg
node broadcast.mjs --personal-only                # skip bot LINE leg
node broadcast.mjs --vault-root <path>            # override vault root
node broadcast.mjs --keep-temp                    # keep build/ on success
node broadcast.mjs --personal-target-groups a,b   # personal-LINE targets
                                                  #   (overrides
                                                  #    LINE_PERSONAL_TARGET_GROUPS)
```

`--bot-only` and `--personal-only` are mutually exclusive. They can compose
with `--dry-run` (e.g. `--bot-only --dry-run`).

Exit codes:

- `0` — success, or every attempted fan-out channel returned ok / dry-run / stub.
- `1` — fatal: a required pipeline step (scrape/deck/archive) failed, OR every
  attempted fan-out channel failed.
- `2` — bad CLI usage.

## Dependencies (relative paths inside our extension)

```
extensions/ai-news-broadcaster/
└── skills/
    ├── ai-news-broadcast/
    │   ├── broadcast.mjs                     ← THIS file
    │   └── personal-line.mjs                 ← exports runPersonalLine(opts) (Stage 6)
    ├── ai-news-scrape/scrape.mjs             ← exports runScrape(opts)
    ├── ai-news-deck/deck.mjs                 ← exports runDeck(opts)
    └── ai-news-archive/archive.mjs           ← exports runArchive(opts)
```

Imports are plain ESM relative imports across `skills/`. Zero new npm deps
introduced this stage; LINE push uses native `fetch` (Node 18+).

## Vendored functions (defined inside this file, not imported)

Per the no-touch + vendor-don't-import policy in `MANIFEST.md` §5, the LINE
push pattern is vendored from `skills/post-meeting-line-digest/digest.mjs`
(read-only). Specifically replicated:

- `getLineToken()` — env-then-`~/.openclaw/openclaw.json` fallback
  (digest.mjs lines 34-41).
- `lineApiPush()` — `fetch` POST to `https://api.line.me/v2/bot/message/push`
  with `authorization: Bearer <token>` and a one-message text payload
  (digest.mjs lines 172-189).

The vendored functions are independent copies. If LINE changes their endpoint
or auth scheme, both files need the same edit.

## Personal-LINE channel (Stage 6 — Path A)

The personal-LINE leg (channel 8b in `plan.md` §4) is implemented in
`personal-line.mjs` (sibling module, imported by this orchestrator). It
**does not invoke any existing skill**. It composes the Computer Use plan
JSON in the **same shape** that
`skills/personal-line-broadcast/broadcast.mjs` emits — so the existing
Claude Desktop executor consumes both broadcasts identically without any
executor changes.

The "vendor exception" memory rule (which says we may invoke this one
existing skill rather than vendor it) was reviewed at Stage 6 and ruled
**theoretical**: the existing planner is meeting-data-bound (requires
`raw/roll_calls/<date>.md` + `raw/meetings/<date>/<bot_id>.deck_done`,
hard-codes the messages, hard-codes its `markerPath` under
`raw/meetings/...`) and would not produce our news payload. We therefore
match the JSON contract the executor consumes, not the planner that
emits it. Path A approved by the original creator 2026-04-26.

### What runPersonalLine writes (live)

```
<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json
```

Contains the full Computer Use plan JSON. The Claude Desktop executor
reads this file and drives LINE.app exactly as it does for the meeting
broadcast. After delivery the executor writes
`<vault>/raw/ai_news/<date>/<run_id>.personal_line_done` (our namespace —
NOT `raw/meetings/...`), mirroring the meeting-side marker convention.

### Async handoff — orchestrator does NOT block on delivery

`runPersonalLine` returns as soon as the plan JSON is written. The actual
LINE delivery happens later, in a separate Claude Desktop session driving
Computer Use on the operator's Mac. Live-run summary line is `plan written (N
groups)` — NOT `delivered to N groups`. If you need delivery confirmation,
read the executor-written `personal_line_done` marker after the fact.

### Tone — slightly more casual than bot LINE

The message body matches the bot LINE template (header → 3 headlines → PDF
note → 3 tips) but with three softer touches: parens-not-em-dash on the
date, an operator-voice preamble (`這兩天值得知道的三則 AI 新聞：`), and warmer
tip framing (`💡 給<YourChapter> 夥伴一些小建議：` instead of `💡 給<YourChapter> 夥伴：`).
Same content, slightly more personal voice. See `personal-line.mjs` →
`composePersonalLineMessage`.

### CLI / env

`--personal-target-groups <a,b>` overrides `LINE_PERSONAL_TARGET_GROUPS`
(env-only; no CLI flag for the bot side). Either is comma-separated LINE
group display names (NOT C-prefixed group IDs — the personal channel uses
LINE.app's quick-search by name).

If both are unset, the channel logs a no-op (`personal LINE: no targets
configured`) instead of failing — matching bot-LINE behavior with empty
`LINE_TARGET_GROUP_IDS`.

In dry-run the channel composes the message + plan in memory, logs both,
and returns `dry-run (N groups: a, b)` in the summary block. Nothing is
written.

## Seam notes (worth knowing for the next stage)

1. **Archive `--dry-run` does not write a marker.** `runArchive({ dryRun: true })`
   composes the markdown in memory and returns it as `result.markdown`; it
   does NOT touch disk and does NOT write `<vault>/raw/ai_news/<date>/<hhmm>.archive_done`.
   The orchestrator's summary line therefore says
   `archive: (dry-run — composed in memory, not written)` instead of a path.
   Live runs read the marker and report the canonical archive .md path.
2. **Deck `--dry-run` does not render a PDF.** `runDeck({ dryRun: true })`
   writes only `deck.html` + `curated.json`; `deck.pdf` is never created
   (no Chrome required). The orchestrator detects this via `result.renderedPdf`
   and passes `deck.html` to `runArchive` as the `--deck` argument so that
   archive's `existsSync(deck)` check succeeds. Bytes are never read in
   dry-run mode, so the file type doesn't matter.
3. **The orchestrator never spawns.** Imports are direct. `import.meta.url`
   guards at the bottom of each sub-skill file keep their `main()` from
   auto-firing on import.

See `../../MANIFEST.md` and `../../plan.md` for the full design context.
