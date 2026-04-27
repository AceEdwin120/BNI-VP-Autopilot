# MANIFEST — AI News Broadcaster extension

> **Audience:** another AI (or human engineer) working on the BNI Masta codebase.
> Read this BEFORE you change anything in `bni-masta/skills/`, `bni-masta/SOUL.md`, or `~/.openclaw/secrets/bni-masta.env`. This document tells you exactly what this extension touches, depends on, and adds — so you can build adjacent features without conflicts.
>
> **Version:** 0.7.0 (Stage 7 — install-ready: full-chain `--dry-run` integration test green; `--test-targets` flag + `config/test-targets.json` for the BNI Masta 測試 install-time live test; LaunchAgent plist + install/uninstall scripts; `INSTALL.md` checklist; `tools/verify-sources.mjs`; **Threads permanently dropped per the original creator 2026-04-26**)
> **Last updated:** 2026-04-26
> **Owner:** the operator (alexma@goldenraintree.tw)
> **Stage:** 7 of 7 (see `plan.md` §14 for the full implementation order; v1.1 was eliminated when Threads was permanently dropped at plan v0.5)

---

## 1. What is this feature?

The AI News Broadcaster is an **additive sub-agent** that runs every 2 days at 09:00 Taipei. It scrapes ~20 public Facebook pages of AI labs / AI media / Taiwanese tech publishers, picks the top 3 most important AI news items of the period, translates and summarizes them into Traditional Chinese (繁體中文), generates "how <YourChapter> 會員 can use this" tips, builds a slide-deck PDF, archives the run as a browseable Markdown doc, and broadcasts the result to LINE through two parallel channels (BNI Masta bot account + the operator's personal LINE via Computer Use). Everything lives under this `extensions/ai-news-broadcaster/` folder. It does not modify any pre-existing file in the BNI Masta tree.

See `plan.md` for the full design spec.

---

## 2. Where does everything live?

All files added by this extension live inside `extensions/ai-news-broadcaster/`:

```
extensions/ai-news-broadcaster/
├── MANIFEST.md                          ← this file (integration handoff)
├── plan.md                              ← full design spec (was skills/ai-news-broadcast/plan.md)
├── package.json                         ← local-scoped npm manifest (apify-client@^2.23.0 — Stage 2)
├── package-lock.json                    ← committed lockfile (Stage 2)
├── node_modules/                        ← local-only npm install (Stage 2; gitignore-able)
├── config/                              ← Stage 2 — feature configs
│   └── sources.json                     ← 20-entry FB source pool (8A + 5B + 7C); install-time verification flips stale ones
└── skills/
    ├── ai-news-broadcast/               ← orchestrator (Stages 5+6 — IMPLEMENTED)
    │   ├── SKILL.md                     ← real (Stage 5; Stage 6 section appended)
    │   ├── broadcast.mjs                ← real (Stage 5) — in-process; imports the other 3 + personal-line
    │   └── personal-line.mjs            ← real (Stage 6) — exports runPersonalLine; emits Computer Use plan JSON
    ├── ai-news-scrape/                  ← Apify Facebook scraper (Stage 2 — IMPLEMENTED)
    │   ├── SKILL.md                     ← real (Stage 2)
    │   └── scrape.mjs                   ← real (Stage 2)
    ├── ai-news-deck/                    ← curate + 繁中 translate + HTML→PDF deck (Stage 3 — IMPLEMENTED)
    │   ├── SKILL.md                     ← real (Stage 3)
    │   └── deck.mjs                     ← real (Stage 3)
    └── ai-news-archive/                 ← Markdown archive writer (Stage 4 — IMPLEMENTED)
        ├── SKILL.md                     ← real (Stage 4)
        └── archive.mjs                  ← real (Stage 4)
```

**Why nested under `extensions/ai-news-broadcaster/skills/` instead of the project-root `skills/`?** Two reasons:

1. The parent BNI Masta agent autoloads skills it finds under `bni-masta/skills/`. By keeping our skill folders nested one level deeper under `extensions/`, the parent will NOT autoload them. The orchestrator will invoke them by direct path (`node extensions/ai-news-broadcaster/skills/ai-news-scrape/scrape.mjs ...`).
2. A single `extensions/<feature>/` folder is a clean, self-contained unit — easy to enable/disable (move out of the way), easy to inspect, easy to delete. It signals "additive, not core."

If you (the integrating AI) want to add your own additive feature, mirror this layout: `extensions/<your-feature>/` with its own `MANIFEST.md`, `plan.md`, `package.json`, and nested `skills/`.

---

## 3. What existing files does this feature READ from / INVOKE?

These are the files in the parent BNI Masta tree we read from or shell out to. **If you change any of these, our feature may break.** See §5 for the specific contract surface (functions / shapes / paths) we depend on.

| Path | What we use it for | How we use it |
|---|---|---|
| `skills/personal-line-broadcast/broadcast.mjs` | Personal-LINE Computer Use executor contract — schema reference only | We do NOT import, fork, or invoke it. We READ it once at Stage 6 to reverse-engineer the JSON shape the Claude Desktop executor consumes (`{skill, pipeline, runtime, date, botId/runId, mode, payloadKind, targets, messages, markerPath, sendGapMs, instructions}`). Our `personal-line.mjs` (lives in `skills/ai-news-broadcast/`, Stage 6) emits the **same shape** so the same executor consumes both broadcasts. The "vendor exception" rule (which would have allowed invoking this one skill rather than vendoring) was reviewed at Stage 6 and ruled theoretical: the existing planner is meeting-data-bound and would not produce our news payload. See §6.3.4 below. |
| `skills/personal-line-broadcast/SKILL.md` | Reference for how Computer Use availability works | Read-only; we mirror the same operational model (live Claude Desktop session at trigger time). |
| `skills/meeting-deck-report/deck.mjs` | Pattern reference for Chrome-headless PDF render + `gog drive upload`/`gog drive share` | We **vendor (copy-paste)** patterns into `skills/ai-news-deck/deck.mjs` (Stage 3) and (later) the Stage-5 orchestrator. Stage-3 vendors: the `CHROME` const at line `14`, the `loadEnvFile()` env-loader at lines `19-26`, and the `spawnSync(CHROME, [...])` PDF-render invocation at lines `427-435`. Stage-5 will vendor the `gog drive upload/share` helpers at lines `285-312`. We do not import this file. |
| `skills/post-meeting-line-digest/digest.mjs` | Pattern reference for LINE Messaging API push (`sendLine()` ~15-line `fetch` POST) and env-loading (`loadEnvFile`) | Same — we vendor the pattern, do not import. |
| `~/.openclaw/secrets/bni-masta.env` | Shared secrets file | We **read** existing keys (`LINE_CHANNEL_ACCESS_TOKEN`, `ALEX_LINE_ID`) and we **append** new keys (see §6). We never overwrite or remove existing keys. |
| `~/.openclaw/openclaw.json` | Fallback secrets file (for `LINE_CHANNEL_ACCESS_TOKEN` + the operator's userId) | Read-only fallback, mirrors what `post-meeting-line-digest/digest.mjs` does. |
| `SOUL.md` | Behavioral contract (cost ceilings, confirmation rules) | Read-only — informs our cost cap (`MAX_SCRAPE_COST_USD=0.50`, well under the SOUL-defined $1 confirmation threshold). |

---

## 4. What existing files does this feature MODIFY?

**NONE. This feature is strictly additive.**

Verified at Stage 1 by checksumming every existing file before scaffolding (31 files under `bni-masta/` excluding our extension folder). The post-Stage-1 verification re-checksums the same set and asserts byte-identical match.

If a future stage of this feature requires modifying ANY existing file, the implementing AI MUST stop and surface that to the operator first. This is a hard constraint, not a guideline. See `plan.md` §2 ("No-touch rule") and §13 (verified file list this plan does not touch).

---

## 5. What existing files does this feature DEPEND ON? (contract surface)

These are the specific things in the parent codebase that, if changed, will break us. If you (the integrating AI) modify any of these contracts, please coordinate with this extension's owner before merging.

### 5.1 Personal-LINE Computer Use executor schema

**File:** `skills/personal-line-broadcast/broadcast.mjs`
**Function:** the JSON shape emitted to stdout in plan mode (`broadcast.mjs <date> <bot_id>`)
**Specifically:** the keys `{skill, pipeline, runtime, date, botId, mode, payloadKind, targets, messages, markerPath, sendGapMs, instructions}` and the `instructions` step list that the Claude Desktop Computer Use executor follows. Our `personal-line.mjs` (Stage 6) emits the same shape — `runId` replaces `botId` in our marker path namespace, and our values populate `skill` (`"ai-news-broadcast"`) / `pipeline` (`"ai-news-broadcast"`) / `markerPath` (under `raw/ai_news/...`) / `messages` (news headlines + tips). The same Claude Desktop executor consumes both unchanged.

If you change the schema or the executor's expected steps, our `personal-line.mjs` breaks silently — the executor will still try to run but may target the wrong inputs. Coordinate cross-skill before changing the schema.

### 5.2 LINE Messaging API push helper pattern

**File:** `skills/post-meeting-line-digest/digest.mjs`
**Function:** `sendLine()` — the `fetch` POST to `https://api.line.me/v2/bot/message/push` using `LINE_CHANNEL_ACCESS_TOKEN`
**Function:** `getLineToken()` / `getOperatorLineId()` — env-then-openclaw.json fallback
**Function:** `loadEnvFile()` — the simple `KEY=VALUE` env-file loader

We vendor this pattern (copy, not import). If LINE changes their API endpoint or auth header, both files need updating — but our copy is independent so the change won't cascade automatically.

### 5.3 Chrome-headless PDF render pattern

**File:** `skills/meeting-deck-report/deck.mjs`
**Function:** the `spawnSync(CHROME, [...])` invocation (lines 427-435)
**Const:** `CHROME` path resolution (line 14)

We vendor the pattern. If macOS upgrades change the Chrome binary path, both files need the same fix. Stage 3 has copied this verbatim into `skills/ai-news-deck/deck.mjs` (the `renderPdfViaChromeHeadless()` helper). Each vendored block carries a comment block above it pointing to the source file + line range.

### 5.4 Google Drive upload + share pattern

**File:** `skills/meeting-deck-report/deck.mjs`
**Function:** `ensureDriveFolder()` + `uploadAndShare()` (around lines 285-312)
**External:** the `gog` CLI tool (Google CLI) and its `drive search / create-folder / upload / share` subcommands; the `DRIVE_ACCOUNT` env var
**Drive folder:** parent uses `BNI-AI-News/` is OURS, deck.mjs uses its own — namespaces are separate, no collision

We vendor the pattern. If `gog`'s CLI surface changes, both files need updating in parallel.

### 5.5 Vault paths used at runtime

**Const in multiple files:** `VAULT = "<vault-path>"`
**Env override:** `BNI_VAULT_DIR`

We use the same vault root for our `archive/ai_news/` and `raw/ai_news/` subfolders (see §7). If the vault root moves, both the existing skills and our extension need to follow.

---

## 6. What new external dependencies does this feature add?

### 6.1 npm packages

**Stage 2 added:** `apify-client@^2.23.0` (Apify's official JS SDK) — pinned in `extensions/ai-news-broadcaster/package.json` and installed locally into `extensions/ai-news-broadcaster/node_modules/` (~16 MB, 67 transitive packages). Not added to any parent package.json (the bni-masta root has no package.json by design). The lockfile is committed.

**Stage 3 added:** `@anthropic-ai/sdk@^0.91.1` — pinned in the same `extensions/ai-news-broadcaster/package.json`. Used by `skills/ai-news-deck/deck.mjs` for the single combined curate + 繁中 translate + tips Anthropic call (model `claude-haiku-4-5-20251001`). Adds 4 packages and ~9 MB to `node_modules/` (combined size now ~25 MB).

**Stage 4 added:** _none_. `ai-news-archive/archive.mjs` is pure Node 18+ stdlib (`node:fs`, `node:path`, `node:url`, `node:os`). Zero new npm dependencies; `node_modules/` size unchanged.

**Stage 5 added:** _none_. `ai-news-broadcast/broadcast.mjs` is pure Node 18+ stdlib + in-process imports of the three sibling sub-skills. The bot LINE push uses native `fetch` (no `node-fetch`/`axios`). Zero new npm dependencies; `node_modules/` size unchanged.

**Stage 6 added:** _none_. `ai-news-broadcast/personal-line.mjs` is pure Node 18+ stdlib (`node:fs`, `node:path`). No spawn, no subprocess. Zero new npm dependencies; `node_modules/` size unchanged.

Any future stage that needs a new npm dep adds it here too — never in a parent package.json.

### 6.2 New environment variables (added to `~/.openclaw/secrets/bni-masta.env`)

These keys are NEW. None collide with existing keys. They will be appended at install time (Stage 7), not at Stage 1.

```
APIFY_TOKEN=apify_api_xxx                    # Apify scraper auth (Stage 2)
ANTHROPIC_API_KEY=sk-ant-...                 # Anthropic Messages API auth (Stage 3) — used by ai-news-deck/deck.mjs for the single combined curate+translate+tips call (claude-haiku-4-5-20251001)
BNI_AINEWS_LINE_GROUP_IDS=Cxxx,Cyyy          # LINE bot push targets (groups, OA-installable)
BNI_AINEWS_PERSONAL_TARGETS=群1,群2          # Personal-LINE Computer Use targets (display names)
BNI_AINEWS_PERSONAL_TEST_TARGETS=<YourTestGroup>
BNI_AINEWS_PERSONAL_MODE=test                # test|production
BNI_AINEWS_MODE=test                         # test|production (orchestrator-level gate)
BNI_AINEWS_SOURCES_FILE=                     # optional override for sources.json path
BNI_AINEWS_ARCHIVE_DIR=<vault-path>/archive/ai_news
MAX_SCRAPE_COST_USD=0.50                     # Apify per-run safety cap
```

> Threads-related env vars (e.g. `BNI_AINEWS_THREADS_ENABLED`) are intentionally absent. Threads was permanently dropped at plan v0.5 (2026-04-26) — see plan.md §3 / §6 / §15.

`ANTHROPIC_API_KEY` should be appended to the existing `~/.openclaw/secrets/bni-masta.env` file (same secrets file the meeting pipeline reads — see §3 above; `loadEnvFile()` is the same vendored loader on both sides). Do NOT create a new secrets store. If the user already has an `ANTHROPIC_API_KEY` set there for another reason, this skill will reuse it transparently.

**Stage 4 env vars added:** _none_. The archive writer recognizes `BNI_VAULT_ROOT` as a vault-root resolution preference and falls back through `BNI_VAULT_DIR` (already used by Stage 2) and convention paths — but neither is required if `--vault-root` is passed on the CLI, and both are already-listed env names, not new ones.

**Stage 5 env vars introduced (NEW — required for live bot LINE push):**

```
LINE_CHANNEL_ACCESS_TOKEN=<long-lived LINE Messaging API channel access token>
LINE_TARGET_GROUP_IDS=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,Cyyyyyyyy...
```

- `LINE_CHANNEL_ACCESS_TOKEN` — the Messaging API channel access token for the BNI Masta bot/OA. Same env name the existing `post-meeting-line-digest/digest.mjs` reads (Stage 5 reuses the operator's existing token; nothing new on the LINE Developers console required). Vendored loader pattern means the token lives in `~/.openclaw/secrets/bni-masta.env` (same secrets file as everything else).
- `LINE_TARGET_GROUP_IDS` — comma-separated list of LINE group IDs where the OA bot is installed and should receive the broadcast. Each ID is `C` + 32 hex chars. Empty/unset is allowed in `--dry-run`; live mode logs a no-op when empty.

`LINE_TARGET_GROUP_IDS` is a NEW key. `LINE_CHANNEL_ACCESS_TOKEN` is technically pre-existing (used by `post-meeting-line-digest`) but is documented here because Stage 5 is the first place this extension reads it directly. Both should be appended to `~/.openclaw/secrets/bni-masta.env` at install time (Stage 7) — not at Stage 5. There's also a coexisting key `BNI_AINEWS_LINE_GROUP_IDS` in §6.2 above, kept as a future-proof alias if the operator wants to namespace news-bot targets separately from any other future LINE feature; Stage 5 reads `LINE_TARGET_GROUP_IDS` per the orchestrator spec.

**Stage 6 env vars introduced (NEW — required for live personal-LINE plan emission):**

```
LINE_PERSONAL_TARGET_GROUPS=<YourChapter> 學員交流, BNI 副主席群
```

- `LINE_PERSONAL_TARGET_GROUPS` — comma-separated **LINE group display names** (NOT C-prefixed group IDs) where the operator's personal LINE account should deliver the news broadcast. The personal-LINE channel uses LINE.app's quick-search by name; the executor types each name into the search field. Empty/unset is allowed — the channel logs a no-op in that case (does not abort the run). Can be overridden per-invocation via `--personal-target-groups <a,b>` on the orchestrator CLI.
- Optional companions, both already documented above in this section: `BNI_AINEWS_PERSONAL_MODE` (test|production; default test), `BNI_AINEWS_PERSONAL_DELAY_MS` (between-message delay; falls back to existing `BNI_PERSONAL_LINE_DELAY_MS`, default 1500).

`LINE_PERSONAL_TARGET_GROUPS` is a NEW key. It does NOT collide with the existing meeting-side `BNI_PERSONAL_LINE_TARGETS` / `BNI_PERSONAL_LINE_TEST_TARGETS` (different namespace; news targets and meeting targets can differ). Should be appended to `~/.openclaw/secrets/bni-masta.env` at install time (Stage 7).

**Existing env keys we READ (do not modify):** `LINE_CHANNEL_ACCESS_TOKEN`, `ALEX_LINE_ID`, `BNI_VAULT_DIR`.

### 6.3 New system requirements

- **Apify account + API token** — free tier is sufficient given our usage (~$1–$2/mo of Apify activity, covered by the $5/mo free credit).
- **Apify actor pinned (Stage 2):** `apify/facebook-posts-scraper` — the official Apify-maintained Facebook Posts scraper. Verified live on the Apify store at Stage 2. Selected over alternatives (`scrapier/facebook-posts-scraper`, `automation-lab/facebook-posts-scraper`, `apify/facebook-pages-scraper`) because it (a) is the official Apify-namespaced actor, (b) is the canonical "best Facebook scraper on Apify" per Apify's own 2026 roundup, (c) accepts the simple `startUrls` + `resultsLimit` + `onlyPostsNewerThan` input shape we need, and (d) is the most-used and most-likely-to-be-maintained option. Pin lives in `skills/ai-news-scrape/scrape.mjs` as the `APIFY_ACTOR` constant; swap requires editing that constant AND this manifest line.
- **launchctl plist** — a new file `~/Library/LaunchAgents/com.bni-masta.ai-news-broadcast.plist` will be installed at Stage 7. Does NOT modify the existing `meeting-poll` LaunchAgent.
- **Live Claude Desktop session at 09:00 every 2 days** — required for the personal-LINE leg (8b), same operational model as the existing `personal-line-broadcast` skill.

### 6.3.1 Stage 5 architecture — in-process composition

**Decision (Stage 5, original creator):** the orchestrator (`ai-news-broadcast/broadcast.mjs`) does NOT spawn the three sub-skills as child processes. It imports them as ESM modules and calls their exported `runScrape(opts)` / `runDeck(opts)` / `runArchive(opts)` functions directly. One Node process drives the whole pipeline — no subprocess fork, no stdout parsing, no string-marshalling of CLI flags between layers. The `dryRun` flag cascades by being passed straight into each step's options object.

To make this work without breaking the existing CLIs, each sub-skill (`scrape.mjs`, `deck.mjs`, `archive.mjs`) was refactored at Stage 5 to:

1. Expose `export async function runX(opts)` that takes a typed options object and returns `{ ok, summary, ...result }` (output paths, counts, etc.) instead of writing the OK summary to stdout / calling `process.exit` on bad input.
2. Keep its `main()` function as a thin shell that parses argv, calls `runX`, prints the OK line, and exits — guarded by `if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()` so importing the module does NOT auto-fire its CLI.
3. Throw `Error` for hard failures (bad input, missing token in non-dry-run, all-empty posts, etc.) instead of `console.error` + `process.exit(1)`. The CLI shell catches and exits 1; the orchestrator catches and aborts the pipeline.

**CLI behavior is byte-identical to Stages 2/3/4** — every existing `node X.mjs --dry-run` / live invocation still produces the same `[ai-news-X] OK — ...` summary line. Verified by re-running each sub-skill's standalone `--dry-run` after the refactor.

**Public API surface (inside our extension only — not exported beyond):**

| Module | Exported symbol | Used by |
|---|---|---|
| `skills/ai-news-scrape/scrape.mjs`   | `runScrape({ dryRun, source, sinceHours, perPageLimit, out, noDedupe, sourcesPath, vaultRoot })` | `ai-news-broadcast/broadcast.mjs` |
| `skills/ai-news-deck/deck.mjs`       | `runDeck({ input, outDir, dryRun, topN, noRender })` | `ai-news-broadcast/broadcast.mjs` |
| `skills/ai-news-archive/archive.mjs` | `runArchive({ scrape, curated, deck, vaultRoot, dryRun })` | `ai-news-broadcast/broadcast.mjs` |

These exports are part of the integration contract WITHIN this extension. They are not consumed by anything outside `extensions/ai-news-broadcaster/`. If a future stage needs to refactor either the option shape or the result shape, all three callers (the CLI `main()` shell, the orchestrator, and any new caller) need to be updated together.

### 6.3.2 Stage 5 vendored function — bot LINE push

`ai-news-broadcast/broadcast.mjs` defines `pushBotLine(curated, deckUrl)` (and helper `lineApiPush()` + `getLineToken()`) **vendored** from `skills/post-meeting-line-digest/digest.mjs` (read-only; see MANIFEST §5.2). Specifically replicated:

- `getLineToken()` — env-then-`~/.openclaw/openclaw.json` fallback (digest.mjs lines 34-41).
- `lineApiPush()` — `fetch` POST to `https://api.line.me/v2/bot/message/push` with `authorization: Bearer <token>` header and a one-message text payload (digest.mjs lines 172-189).

The vendored functions are independent copies. If LINE changes the endpoint or the auth scheme, both files need the same edit.

### 6.3.4 Personal-LINE channel — Stage 6 (Path A — implemented)

**Decision (Stage 6, original creator):** the personal-LINE channel **does NOT invoke any existing skill**. Specifically, it does NOT spawn `skills/personal-line-broadcast/broadcast.mjs`. Instead, our `personal-line.mjs` composes the Computer Use plan JSON in the **same shape** that planner emits, and writes it to our own namespace (`<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json`). The existing Claude Desktop executor consumes both broadcasts identically — no executor changes needed.

**Why not invoke the existing planner?** It is meeting-data-bound:

1. Requires `<YYYY-MM-DD> <bot_id>` (UUID) positional args we'd have to fake.
2. Reads `raw/roll_calls/<date>.md` + `raw/meetings/<date>/<bot_id>.deck_done` — files we don't produce; missing → `✗ no roll_call at ...` and exit 1.
3. Hard-codes the messages as "stats + PDF link" from meeting frontmatter — not our news headlines + tips.
4. `--dry-run` produces the literal string `"OK"` to test targets — zero news content.
5. Hard-codes `markerPath` to `raw/meetings/<date>/<bot_id>.personal_line_done` — wrong namespace for AI news.

**Vendor-pattern memory exception status (clarification).** The vendor-pattern memory rule reads "vendor existing skills, don't invoke them; the personal-line-broadcast skill is the documented exception, we invoke it." At Stage 6 that exception was reviewed and ruled **theoretical** for this extension: the planner's data contract is incompatible with our payload, so invoking it would produce no value. We instead match the JSON contract the EXECUTOR consumes (which is the actual coupling point). The "executor" is a Claude Desktop Computer Use session — not something this extension reimplements either way. Net effect: zero existing skills are invoked or vendored from `personal-line-broadcast`; we depend only on the schema (read-only, captured in §5.1).

**Async handoff.** `runPersonalLine` returns as soon as the plan JSON is written to disk. The actual LINE delivery happens later, in a separate Claude Desktop session driving Computer Use. Live-run summary is `plan written (N groups)` — NOT `delivered to N groups`. Per-target delivery confirmation lives in the executor-written `<run_id>.personal_line_done` marker, written async.

**`runPersonalLine` shape** (called from `broadcast.mjs` under `step 4/4: LINE fan-out`):

```js
runPersonalLine({
  curated, deckUrl, deckPath, archiveUrl,
  runDate, runId, vaultRoot,
  targetGroups,           // string[] of LINE group display names
  postsById, sourcesById, // for source-label resolution
  dryRun,
})
=> { ok: bool, plannerJsonPath, message, targetGroups, plan, summary }
```

Returns `{ ok: true, dryRun: true, ...}` in `--dry-run` (skips writing the JSON; logs message + targets only). Returns `{ ok: true, noop: true, ...}` if `targetGroups` is empty (matches bot-LINE behavior on empty `LINE_TARGET_GROUP_IDS`). Throwing is suppressed — failures return `{ ok: false, summary }` so `Promise.allSettled` in the orchestrator does not abort the bot leg.

### 6.4 No changes to

- The parent project's `package.json` (there isn't one at the bni-masta root, and we won't add one).
- The parent agent's autoload roster (we deliberately nested under `extensions/.../skills/` so it won't autoload).
- Any pre-existing launchctl plist.
- The `gog` CLI configuration.

---

## 7. What does this feature WRITE to disk on the user's machine?

All paths below are created at runtime (Stage 2+), not at Stage 1. Stage 1 writes nothing outside `extensions/ai-news-broadcaster/`.

| Path | When | What | Lifecycle |
|---|---|---|---|
| `<vault>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.md` | Each archive write (Stage 4) | One Markdown doc per broadcast (full content + run log + raw scan table). On filename collision the writer appends `_<n>` (`_1`, `_2`, ...) rather than overwriting. | Permanent — this is the canonical archive |
| `<vault>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.deck.pdf` | Each archive write (Stage 4) | Byte-for-byte copy of the Stage-3 `deck.pdf`, placed next to the .md so the archive folder is self-contained. Same suffix as the .md if a collision occurred. | Permanent — paired with the .md |
| `<vault>/archive/ai_news/INDEX.md` | Each archive write (Stage 4) | Rolling index, newest first. **Created on first run, then mutated-in-place every subsequent run** — the new row is prepended directly below the markdown-table divider; everything else (header, blurb, prior rows) is preserved verbatim. **This is the only file in the entire extension that we mutate-in-place anywhere — see §10.2 callout.** | Permanent — grows by one row per run |
| `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>_scrape.json` | Each scrape (Stage 2) | Normalized post output (see `skills/ai-news-scrape/SKILL.md`) | Permanent until pruned — input for Stage 5 curate |
| `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>.scrape_done` | Each scrape (Stage 2) | Stage 2 idempotency marker (post count, source count, dedupe count, output path). The other markers (`curate_done`, `deck_done`, `archive_done`, `bot_line_done`, `personal_line_done`) keyed by `<run_id>` arrive in Stages 3–5. | Permanent — used to skip completed steps on rerun |
| `<vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>.archive_done` | Each archive write (Stage 4) | Stage 4 idempotency marker. JSON body: `{done, at, run_id, archive_md, archive_deck_pdf, index, suffix, items, sources_scanned, posts_after_dedupe}`. Overwrites on rerun (same slot, latest wins) — the `suffix` field tells the orchestrator which copy of the archive .md was actually produced. | Permanent — same lifecycle as the scrape marker |
| `<vault>/raw/ai_news/<YYYY-MM-DD>/<run_id>.personal_line_plan.json` | Each personal-LINE plan emit (Stage 6) | Computer Use plan JSON consumed by the Claude Desktop executor. Schema mirrors the JSON shape `skills/personal-line-broadcast/broadcast.mjs` emits to stdout (see §5.1) — `{skill, pipeline, runtime, date, runId, mode, payloadKind, targets, messages, markerPath, sendGapMs, instructions}`. Path is in OUR namespace (`raw/ai_news/...`), not `raw/meetings/...`. Written by `personal-line.mjs` → `runPersonalLine()`. NOT written on `--dry-run`. | Permanent — read by executor on next Claude Desktop session |
| `<vault>/raw/ai_news/<YYYY-MM-DD>/<run_id>.personal_line_done` | Each personal-LINE delivery (Stage 6, async) | Per-target results JSON, written by the **Claude Desktop executor** (NOT by this extension's code) after Computer Use drives LINE.app. Path is the `markerPath` field of the plan JSON above; same shape as the meeting-side `personal_line_done` marker. | Permanent — orchestrator reads on re-runs for idempotency (Stage 7+) |
| `<vault>/raw/ai_news/_seen.jsonl` | Every run | Rolling log of `{post_id, picked_at, similarity_hash}` for dedupe | Auto-pruned to last 30 days at end of each run |
| `<vault>/raw/ai_news/cache/<YYYY-MM-DD>_posts.jsonl` | Each scrape | Normalized scrape output, kept for `--skip-scrape` re-runs | Auto-pruned to last 7 days |
| `<vault>/wiki/meeting_reports/` | NEVER | (existing meeting deck folder — we do not write here) | n/a |
| `<vault>/wiki/ai_news_decks/<YYYY-MM-DD>_deck.{html,pdf}` | Each deck build | Local deck artifacts before Drive upload | Permanent locally; PDF copy lives canonically on Drive |
| `<out-dir>/deck.html` | Each Stage-3 run | Source HTML rendered into the deck (kept for debugging) | Lifecycle owned by the orchestrator's `<out-dir>` (Stage 5); transient |
| `<out-dir>/deck.pdf` | Each Stage-3 run (live or `--no-render`-skipped otherwise) | The 6-page PDF deliverable (cover + 3 items + tips + back-cover) | Same as above; copied into the vault path by Stage 5 |
| `<out-dir>/curated.json` | Each Stage-3 run | LLM-curated payload (top-N items + 3 tips) — input for Stage 4 archive | Same as above; consumed by `ai-news-archive` |
| Google Drive folder `BNI-AI-News/` | Each successful deck build | The PDF, named `<YYYY-MM-DD>_<YourChapter>_AI新聞_<HHmm>.pdf`, shared anyone-reader | Permanent on Drive |
| `~/Library/LaunchAgents/com.bni-masta.ai-news-broadcast.plist` | One-time at Stage 7 install | The schedule trigger | Removed by `launchctl unload` + `rm` if uninstalled |

**Naming-convention guarantees:**
- Every runtime path is namespaced under `ai_news/` so it cannot collide with the existing meeting pipeline (`raw/meetings/...`, `wiki/meeting_reports/...`).
- Every idempotency marker is keyed by `<run_id>` (UUID per run) rather than `<bot_id>` (used by the meeting pipeline) — same naming pattern, separate namespace.

---

## 8. How is this feature invoked?

### 8.1 Scheduled (production)

A launchctl `StartCalendarInterval` at `Hour=9 Minute=0` runs daily; the orchestrator's idempotency check aborts if `archive/ai_news/<today>_*.md` already exists OR the last successful run was <40 hours ago. Net effect: every-2-day cadence, self-correcting if the machine was asleep.

### 8.2 Manual (during development / recovery)

Entry point: `extensions/ai-news-broadcaster/skills/ai-news-broadcast/broadcast.mjs`

```
node broadcast.mjs                                # full pipeline, last 48h window
node broadcast.mjs --dry-run                      # scrape + curate + deck + archive, NO LINE
node broadcast.mjs --skip-scrape <posts.jsonl>    # rerun curation on cached scrape
node broadcast.mjs --force                        # bypass idempotency check
node broadcast.mjs --bot-only                     # skip personal-LINE leg
node broadcast.mjs --personal-only                # skip bot-LINE leg
node broadcast.mjs --personal-only --run-id <id>  # re-trigger 8b for a specific past run
```

### 8.3 Slash-command (Claude Desktop)

`/ai-news-broadcast` — exposed as a top-level skill the agent can invoke. The orchestrator drives both LINE channels in one Claude Desktop session.

---

## 9. What this feature does NOT do (explicit non-goals)

So that adjacent features don't accidentally double-cover scope:

- **No edits to any existing skill.** Strictly additive — see §4.
- **No audio output.** Output is written-only: deck PDF + LINE text + Markdown archive. No TTS, no podcast, no audio rendering.
- **No X / Twitter scraping.** Dropped (cost). Architecture supports re-adding via a `scrape_x.mjs` module + `X_BEARER_TOKEN` env var; not currently planned.
- **No Threads scraping — permanently dropped (plan v0.5, 2026-04-26).** Not in v1, not in any future version. No `BNI_AINEWS_THREADS_ENABLED` flag exists; do not introduce one without an explicit operator decision overturning v0.5.
- **No general AI chatbot behavior.** Strictly a curated news pipeline.
- **No multi-language output.** All user-facing output is Traditional Chinese (zh-TW). Source attribution lines may keep the original page name in the source language for honesty.
- **No opinionated commentary.** Tone is factual digest + actionable tips; no editorial position.
- **No human approval gate.** Production runs are end-to-end automated; failures abort + alert, successes ship without review.
- **No new top-level launchctl plist beyond ours.** We add one new plist (`com.bni-masta.ai-news-broadcast.plist`); we do not touch any existing one.
- **No writes outside `<vault>/{archive,raw,wiki}/ai_news/...`, the local Drive cache, the new launchctl plist, and our own `extensions/ai-news-broadcaster/` folder.** If you see this feature writing anywhere else, that's a bug — please flag it.
- **No dependencies on the parent agent's package.json or autoloader.** Skills nested under `extensions/.../skills/` are NOT autoloaded by the parent.
- **No coordination with the meeting pipelines beyond reading the same `bni-masta.env` secrets file.** Marker paths, Drive folders, and LINE group lists are namespaced separately so the two features cannot collide at runtime.

If your feature needs to do any of the above, you are NOT stepping on this feature's toes — but please coordinate marker-path / env-key / Drive-folder naming with this extension's owner before deploying so we don't pick the same namespace by accident.

---

## 10. Coordination notes for the integrating AI

### 10.1 Safe to do without coordination

- Add another extension under `extensions/<your-feature>/` with the same layout pattern.
- Add new skills under the project-root `skills/` (the parent autoloader will pick them up; we do not).
- Add new env vars to `~/.openclaw/secrets/bni-masta.env` as long as they don't collide with the keys in §6.2.
- Read any of the existing skill files (we do too).

### 10.1.1 INDEX.md is the only file we mutate-in-place — anywhere

Every other path this extension writes is either net-new (per-run .md, per-run .deck.pdf, per-run scrape.json) or a one-shot marker that is overwritten as a unit. **`<vault>/archive/ai_news/INDEX.md` is the sole file we read, modify, and rewrite atomically every run.** Stage 4 (`ai-news-archive/archive.mjs`) is the only writer; the prepend logic locates the markdown-table divider line and inserts the new row immediately after it, preserving the header, blurb, and all prior rows verbatim.

Operational implications for an integrating AI:

- If you want to alter the INDEX format (extra columns, sort, etc.), do it in `archive.mjs` and re-render — do not hand-edit the file, because the next run will append a row in the previous format and break alignment.
- If you build another feature that also wants to write under `<vault>/archive/`, **pick a different filename** — INDEX.md is reserved for this extension.
- The rest of the extension is strictly append-only or new-file-only (per-run .md, per-run .deck.pdf, marker files). If you see anything else mutating an existing file in place, that is a bug — please flag it.

### 10.2 Please coordinate before doing

- Modifying `skills/personal-line-broadcast/broadcast.mjs`, `skills/meeting-deck-report/deck.mjs`, or `skills/post-meeting-line-digest/digest.mjs` — these are our contract-surface dependencies (§5). If their schemas/patterns change, our shim/vendored copies will silently drift.
- Renaming the `<vault>/archive/`, `<vault>/raw/`, or `<vault>/wiki/` parent folders.
- Changing the `gog` CLI surface or the `DRIVE_ACCOUNT` semantics.
- Adding any keys to `~/.openclaw/secrets/bni-masta.env` whose names start with `BNI_AINEWS_` — that's our namespace.
- Adding any launchctl plist named `com.bni-masta.ai-news-broadcast*` — that's our slot.

### 10.3 Hard stop — do not do

- Modify any file inside `extensions/ai-news-broadcaster/` without coordinating with this extension's owner.
- Add a flag/branch/conditional inside one of the existing skills that exists "to support AI News Broadcaster." We deliberately chose vendoring over flag-passing for this reason.
- Move the four `extensions/ai-news-broadcaster/skills/<name>/` folders into the project-root `skills/` — the parent autoloader will then double-register them (bad).

---

## 11. How to verify this extension is intact

From the bni-masta root:

```sh
# All four skill stubs should exist
ls extensions/ai-news-broadcaster/skills/{ai-news-broadcast,ai-news-scrape,ai-news-deck,ai-news-archive}/SKILL.md

# Plan + manifest + package.json all present
ls extensions/ai-news-broadcaster/{MANIFEST.md,plan.md,package.json}

# No file under bni-masta/ outside extensions/ai-news-broadcaster/ should differ
# from its Stage-1 baseline. Compare against the checksum manifest captured at
# Stage 1 (kept in the implementation log).
```

If any existing file outside `extensions/ai-news-broadcaster/` shows as modified, something is wrong — investigate before continuing.

---

## 12. Stage history

| Stage | Date | What landed |
|---|---|---|
| 1 | 2026-04-26 | Folder scaffold, plan moved in, MANIFEST written, package.json written, four SKILL.md stubs. No implementation logic. Zero existing files modified. |
| 2 | 2026-04-26 | `ai-news-scrape/scrape.mjs` + real `SKILL.md`. New `config/sources.json` (20 entries: 8A + 5B + 7C). `apify-client@^2.23.0` installed locally. Apify actor pinned: `apify/facebook-posts-scraper`. `--dry-run` validated end-to-end (40-post fixture written; second run successfully dedupes all 40 against the first). Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified. |
| 3 | 2026-04-26 | `ai-news-deck/deck.mjs` + real `SKILL.md`. `@anthropic-ai/sdk@^0.91.1` installed locally (~+9 MB to `node_modules/`). Anthropic model pinned: `claude-haiku-4-5-20251001`. Heuristic pre-rank → top-15 candidates → ONE Anthropic call (combined curate + 繁中 translate + 3 tips) → 6-page deck (cover + 3 items + tips + back-cover) → Chrome-headless PDF render. Vendored from `skills/meeting-deck-report/deck.mjs`: the `CHROME` const at line `14`, the `loadEnvFile()` env loader at lines `19-26`, and the `spawnSync(CHROME, [...])` PDF render at lines `427-435` (each block carries a comment block pointing to the source). New env var `ANTHROPIC_API_KEY` added to §6.2. `--dry-run` validated end-to-end against a 5-post synthetic fixture (no API key, no Chrome required) — `deck.html` (200 lines, 10 KB) + `curated.json` (2.5 KB) written. Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified byte-identical. |
| 4 | 2026-04-26 | `ai-news-archive/archive.mjs` + real `SKILL.md` (replaces stub). Pure Node 18+ stdlib — **zero new npm deps, zero new env vars** (recognizes `BNI_VAULT_ROOT` but already-listed `BNI_VAULT_DIR` / convention paths satisfy resolution). CLI `--scrape <scrape.json> --curated <curated.json> --deck <deck.pdf> [--vault-root <path>] [--dry-run]`. Behavior: composes a single browseable Markdown doc per run with cover metadata + 精選三則 (繁中) + 給<YourChapter> 夥伴的 tips + full raw scan table sorted by `posted_at desc` + run metadata; copies the deck PDF beside the .md as `<date>_<hhmm>.deck.pdf`; prepends a row to `INDEX.md` (created on first run, mutated-in-place thereafter — see §10.1.1); writes `raw/ai_news/<date>/<hhmm>.archive_done` marker mirroring scrape_done convention. Per-run files never overwrite — collisions get suffix `_1`, `_2`, ... up to `_99`. `--dry-run` composes the markdown in memory and prints to stdout, touching no disk. Validated end-to-end with a 3-post synthetic fixture: dry-run rendered cleanly; first real run created all four expected paths under `/tmp/ai-news-archive-test`; second run with a different fixture (date `2026-04-28`) prepended a new row to INDEX.md correctly with the prior `2026-04-26` row preserved below; a third run with the original fixture produced `_1`-suffixed copies and the marker recorded `suffix: 1`. Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified byte-identical. |
| 5 | 2026-04-26 | `ai-news-broadcast/broadcast.mjs` + real `SKILL.md` (replaces stub). **Architecture: in-process composition** (the original creator's Stage-5 decision) — orchestrator imports `runScrape` / `runDeck` / `runArchive` from sibling modules and chains them in a single Node process. No subprocess spawn, no stdout parsing. Each sub-skill (`scrape.mjs`, `deck.mjs`, `archive.mjs`) refactored to expose its main logic as an `export async function runX(opts)` that returns a typed result; their `main()` functions are now thin shells guarded by `if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))` so importing the module does NOT auto-fire its CLI. Standalone CLI `--dry-run` for all three was re-verified byte-identical to Stages 2/3/4. **Bot LINE channel implemented** via `pushBotLine()` + `lineApiPush()` + `getLineToken()` vendored from `skills/post-meeting-line-digest/digest.mjs` (lines 34-41 + 172-189). Composes a 繁中 message: header「📰 AI 趨勢快訊 — YYYY/MM/DD」+ ①②③ headlines with source labels + 「完整簡報 PDF：詳見今日 archive」(Drive upload deferred to v1.1) + 「💡 給<YourChapter> 夥伴：」+ 3 tips. Pushes in parallel to `LINE_TARGET_GROUP_IDS` (comma-separated) via `Promise.allSettled`. **Personal-LINE channel left as a Stage-6 stub** (`pushPersonalLineStub()` — logged no-op returning `{ stub: true }`); orchestrator call site already wired so Stage 6 is a pure implementation swap. New env vars: `LINE_CHANNEL_ACCESS_TOKEN` (reused from existing meeting pipeline; first read by this extension at Stage 5) + `LINE_TARGET_GROUP_IDS` (NEW; comma-separated `C`-prefixed group IDs). Zero new npm deps (LINE push uses native `fetch`). CLI: `[--bot-only] [--personal-only] [--dry-run] [--vault-root <path>] [--keep-temp]` (`--bot-only`/`--personal-only` mutually exclusive). End-to-end `--dry-run` validated against `/tmp/ai-news-broadcast-test`: full pipeline executes in one Node process, summary block prints, exit 0. `--bot-only --dry-run` and `--personal-only --dry-run` both verified. Two seams documented (in SKILL.md and broadcast.mjs comments): (a) `runArchive({ dryRun: true })` writes nothing to disk and returns the markdown in-memory — orchestrator falls back to "(dry-run — composed in memory, not written)" in the summary, no marker file is read; (b) `runDeck({ dryRun: true })` skips Chrome PDF render — orchestrator passes `deck.html` to `runArchive`'s `--deck` arg as a stand-in (archive only `existsSync`-checks the file in dry-run, never reads bytes). Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified byte-identical. |
| 6 (this version) | 2026-04-26 | `ai-news-broadcast/personal-line.mjs` + Stage-6 SKILL.md section (`Personal-LINE channel — Path A`). **Architecture: Path A — composes the Computer Use plan JSON in the same shape `skills/personal-line-broadcast/broadcast.mjs` emits, NO spawn of any existing skill.** Discrepancy review (Stage 6 brief said "spawn the existing planner") resolved with the original creator 2026-04-26: the existing planner is meeting-data-bound and would not produce our news payload, so the "vendor exception" memory rule was reviewed and ruled theoretical for this extension. Net effect: zero existing skills are invoked or vendored from `personal-line-broadcast`; we depend only on the JSON schema (read-only, captured at §5.1). New module exports `runPersonalLine({curated, deckUrl, deckPath, archiveUrl, runDate, runId, vaultRoot, targetGroups, postsById, sourcesById, dryRun, sendGapMs}) => {ok, plannerJsonPath, message, targetGroups, plan, summary}`. Live-run path: writes `<vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json` and logs `[personal-line] planner OK — executor JSON at <path>; executor will pick up next time it polls`. Async handoff — orchestrator does NOT block on delivery; the Claude Desktop executor reads the plan on its next session and writes `<run_id>.personal_line_done` after Computer Use drives LINE.app. Dry-run path: composes message + plan in memory, logs both, returns `dry-run (N groups: ...)` summary, no disk writes. Empty-targets noop matches bot-LINE behavior. Tone: same template as bot LINE (3 headlines + PDF placeholder + 3 tips) with three softer touches — parens-not-em-dash on date, operator-voice preamble (`這兩天值得知道的三則 AI 新聞：`), warmer tip framing (`💡 給<YourChapter> 夥伴一些小建議：`). Wired into `broadcast.mjs`: replaced `pushPersonalLineStub()` call with `runPersonalLine()`; added `--personal-target-groups <a,b>` CLI flag (overrides `LINE_PERSONAL_TARGET_GROUPS` env var); updated `fmtPersonal()` to surface the channel's `summary` field; updated `isChannelOk()` to handle both ok-as-bool (personal) and ok-as-count (bot) shapes. New env var `LINE_PERSONAL_TARGET_GROUPS` (NEW; comma-separated LINE group display names — NOT C-prefixed group IDs; uses LINE.app quick-search by name). Empty/unset is allowed — channel logs no-op. Zero new npm deps (pure Node 18+ stdlib: `node:fs`, `node:path`). Three smoke tests passed: (a) `--dry-run --personal-target-groups "test-group-1,test-group-2"` → summary shows `personal LINE: dry-run (2 groups: test-group-1, test-group-2)` exactly as specified in the Stage 6 brief; (b) `--bot-only --dry-run` → `personal LINE: skipped (--bot-only)`; (c) `--personal-only --dry-run --personal-target-groups foo,bar` → `bot LINE: skipped (--personal-only)`, `personal LINE: dry-run (2 groups: foo, bar)`. Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified byte-identical. |
| 7 | 2026-04-26 | End-to-end `--dry-run` integration test (full chain in one Node process; orchestrator-level dedupe verified across two back-to-back runs); `config/test-targets.json` + `--test-targets` orchestrator flag (overrides env-driven target lists for the install-time live test); `scheduling/com.bni-masta.ai-news.plist` + `scheduling/install.sh` + `scheduling/uninstall.sh` (LaunchAgent fires daily at 09:00 with a state-file gate that exits if today is not a scheduled day — chosen over a one-year explicit-date list because it self-heals across daylight-savings, sleep, and reinstall cycles); `INSTALL.md` (env vars → npm install → source verification → dry-run → live test → install agent); `tools/verify-sources.mjs` (HEAD-checks each FB page, flips dead ones to `active: false`, prints diff). **Threads dropped permanently per the original creator 2026-04-26 — plan bumped to v0.5; every forward-looking Threads reference scrubbed from active sections of plan.md and MANIFEST.md (historical changelog entries left intact).** Sub-agent clean-room review run; punch list (if any) recorded in the Stage 7 final report. Zero pre-existing files modified — sha256 baseline of all 31 framework files reverified byte-identical. |
