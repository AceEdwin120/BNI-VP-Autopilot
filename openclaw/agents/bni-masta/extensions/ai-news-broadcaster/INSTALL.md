# INSTALL — AI News Broadcaster

> Step-by-step checklist the operator follows once before flipping the feature on.
> Each step gets a "✓ Expected output" snippet so success is unambiguous.
> Run from the extension folder: `cd extensions/ai-news-broadcaster && ...`.

---

## Step 1 — Set environment variables

Append the keys below to `~/.openclaw/secrets/bni-masta.env` (do NOT create
a new secrets file). Order does not matter; existing keys in that file are
left untouched.

```
APIFY_TOKEN=apify_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LINE_CHANNEL_ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LINE_TARGET_GROUP_IDS=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,Cyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
LINE_PERSONAL_TARGET_GROUPS=<YourChapter> 學員交流, BNI 副主席群
```

Where each comes from:

- **`APIFY_TOKEN`** — Apify dashboard → Settings → Integrations → API token. Free tier covers our usage.
- **`ANTHROPIC_API_KEY`** — `console.anthropic.com` → API Keys. The Stage 3 deck step uses `claude-haiku-4-5-20251001`. If this key is already set for another skill, leave it — we re-use it.
- **`LINE_CHANNEL_ACCESS_TOKEN`** — LINE Developers Console → BNI Masta channel → Messaging API → "Channel access token (long-lived)". Same key the post-meeting digest pipeline reads — already populated for the operator if the meeting bot is running.
- **`LINE_TARGET_GROUP_IDS`** — comma-separated `C…32hex` group IDs (the BNI Masta bot must be installed in each group). Get one ID by sending a message into the group and watching the LINE webhook log; or by `curl`-ing the Messaging API `/v2/bot/group/{group_id}/...` once the bot has been added. Empty value = bot LINE leg no-ops cleanly.
- **`LINE_PERSONAL_TARGET_GROUPS`** — comma-separated **display names** (NOT C-prefixed IDs) of LINE groups the personal-LINE leg should fan out to. The Computer Use executor types each name into LINE.app's quick-search. Empty value = personal LINE leg no-ops cleanly.

✓ Expected output of `grep -E '^(APIFY_TOKEN|ANTHROPIC_API_KEY|LINE_CHANNEL_ACCESS_TOKEN|LINE_TARGET_GROUP_IDS|LINE_PERSONAL_TARGET_GROUPS)=' ~/.openclaw/secrets/bni-masta.env`:

```
APIFY_TOKEN=apify_api_xxxxxxxxxx...
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx...
LINE_CHANNEL_ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9...
LINE_TARGET_GROUP_IDS=Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LINE_PERSONAL_TARGET_GROUPS=<YourChapter> 學員交流, BNI 副主席群
```

Five lines. If any line is missing, the corresponding leg of the pipeline will refuse to run live (Apify, Anthropic) or no-op (LINE).

---

## Step 2 — `npm install`

```
cd extensions/ai-news-broadcaster
npm install
```

Installs `apify-client@^2.23.0` (Stage 2) + `@anthropic-ai/sdk@^0.91.1` (Stage 3) into `extensions/ai-news-broadcaster/node_modules/`. Nothing else changes.

✓ Expected output (last lines):

```
added N packages, and audited N packages in Ms
N packages are looking for funding
found 0 vulnerabilities
```

The `node_modules/` size should land around ~25 MB. If npm reports vulnerabilities or missing peer deps, surface them — do not silently ignore.

---

## Step 3 — Verify Tier-C 繁中 page URLs are reachable

```
node tools/verify-sources.mjs
```

Probes every entry in `config/sources.json` (all tiers, ~20 pages). Pages that respond with HTTP 404 or 410 get flipped to `active: false` automatically; everything else (200, 5xx, network errors) is left alone. A backup of the original file is written to `config/sources.json.bak` before any mutation.

To dry-run first (recommended on first install):

```
node tools/verify-sources.mjs --dry-run
```

To narrow to one tier:

```
node tools/verify-sources.mjs --tier C
```

✓ Expected output (success, all live):

```
→ probing 20 source(s) from .../config/sources.json
  timeout: 12000ms; retry-once-on-non-404

  ✓ [A] openai-fb              https://www.facebook.com/OpenAI                  → live          HTTP 200
  ✓ [A] anthropic-fb           https://www.facebook.com/anthropic.ai            → live          HTTP 200
  ...
  ✓ [C] appworks-fb            https://www.facebook.com/appworks.tw             → live          HTTP 200

Summary: 20 live, 0 gone, 0 inconclusive
No changes to sources.json — every probed source is live or already inactive.
```

If 1–4 pages are flipped to `active: false`, that is expected (some labs lean X-first and may have stale FB pages). If more than 4 are gone, investigate before continuing — something is wrong with the network or the sources.

---

## Step 4 — Full-chain `--dry-run` test

```
node skills/ai-news-broadcast/broadcast.mjs --dry-run --test-targets
```

Runs the entire pipeline (scrape → deck → archive → LINE fan-out) in a single Node process with `dryRun: true` cascaded into every sub-skill. The `--test-targets` flag loads `config/test-targets.json` and overrides BOTH the bot-LINE group IDs and the personal-LINE display names so this test cannot post to production groups.

Nothing gets pushed to LINE. The bot-LINE message body and the personal-LINE plan JSON contents are both printed to stdout for review.

✓ Expected output (last block):

```
[ai-news-broadcast] DONE — run_id: <YYYYMMDD>_<HHMM>
  scrape: 40 posts from 20 sources
  deck: (html only — dry-run, 6 pages projected)
  archive: (dry-run — composed in memory, not written)
  bot LINE: dry-run (0 groups: none configured)
  personal LINE: dry-run (1 groups: <YourTestGroup>)
```

(`bot LINE: dry-run (0 groups: ...)` is the expected default — `config/test-targets.json` ships with `bot_target_group_ids: []` because the C-prefixed group ID for "<YourTestGroup>" is not stored in the codebase. Paste it into `bot_target_group_ids[]` in `config/test-targets.json` before the next step if you want the live test to also exercise the bot leg.)

Exit code: `0`.

---

## Step 5 — Single LIVE test

```
node skills/ai-news-broadcast/broadcast.mjs --test-targets
```

Same as Step 4 but without `--dry-run`. Real Apify scrape, real Anthropic deck, real Chrome PDF render, real archive write to your vault, real LINE pushes to ONLY the test targets configured in `config/test-targets.json`.

What to verify:

1. **`<YourTestGroup>` group received the personal-LINE plan JSON.** Check `<vault>/raw/ai_news/<YYYY-MM-DD>/<run_id>.personal_line_plan.json` was written. The Claude Desktop executor will pick it up on its next session and drive LINE.app via Computer Use.
2. **Bot LINE got one push** (only if you populated `bot_target_group_ids[]` in `config/test-targets.json` — otherwise this leg no-ops with `LINE_TARGET_GROUP_IDS empty`).
3. **The deck PDF rendered.** Check `<vault>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.deck.pdf` (paired with the `<YYYY-MM-DD>_<HHmm>.md` archive doc).
4. **`INDEX.md` got a new row.** Check `<vault>/archive/ai_news/INDEX.md` — the new row is prepended directly under the header divider.

✓ Expected output (last block):

```
[ai-news-broadcast] DONE — run_id: <YYYYMMDD>_<HHMM>
  scrape: ~80–150 posts from 20 sources
  deck: <vault>/build/ai_news/<run_id>/deck.pdf (6 pages)
  archive: <vault>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.md
  bot LINE: pushed to 0/0 groups   (or 1/1 if bot_target_group_ids was populated)
  personal LINE: plan written (1 groups: <YourTestGroup>) at <vault>/raw/ai_news/.../personal_line_plan.json
```

Exit code: `0`.

If the run aborts, inspect the relevant section of stdout — every step prints its own `✗ Error` line with a stack trace pointing at the failing module. The most common first-time issues are an unset `APIFY_TOKEN`/`ANTHROPIC_API_KEY` (Step 1) or a Chrome binary path mismatch (the `CHROME` const in `skills/ai-news-deck/deck.mjs` — vendored from `meeting-deck-report/deck.mjs:14`).

---

## Step 6 — Install the launch agent

```
bash scheduling/install.sh
```

Validates the plist with `plutil -lint`, copies it to `~/Library/LaunchAgents/com.bni-masta.ai-news.plist`, runs `launchctl load`, and prints the next-fire time. Idempotent — if a prior copy is loaded, it gets unloaded first.

The plist fires daily at 09:00 Taipei. The wrapper (`scheduling/run-if-due.sh`) gates the actual `broadcast.mjs` invocation on a 40-hour state file at `<vault>/logs/ai_news/last_run_date`, so the user-visible cadence is every ~2 days. See the plist header comment for full rationale.

✓ Expected output (last lines):

```
  ✓ launchctl list confirms registration

Next-fire time:
  <YYYY-MM-DD> 09:00 Taipei

Logs:
  <vault>/logs/ai_news/launchd-out.log
  <vault>/logs/ai_news/launchd-err.log

Done.
```

To uninstall later:

```
bash scheduling/uninstall.sh
```

Removes the plist + `launchctl unload`s it. The state file and archive content under `<vault>/{archive,raw,build,logs}/ai_news/` are left intact; delete by hand if you want a fully clean uninstall.

---

## Step 7 — Confirm + walk away

Confirm the next-fire time is correct (today 09:00 if you installed before 09:00 Taipei, otherwise tomorrow 09:00).

After the next 09:00, check:

```
tail -50 <vault>/logs/ai_news/launchd-out.log
ls <vault>/archive/ai_news/
cat <vault>/logs/ai_news/last_run_date
```

✓ Expected output (after a successful auto-run):

```
[2026-04-28T09:00:01...] [run-if-due] last_run_date=... hours_since=... vault=...
[2026-04-28T09:00:01...] [run-if-due] gate=PASS — invoking broadcast.mjs with /opt/homebrew/bin/node
... (the broadcast.mjs run-log)
[2026-04-28T09:02:14...] [run-if-due] ✓ broadcast.mjs succeeded; state_file updated to 2026-04-28
```

```
INDEX.md
2026-04-26_<HHmm>.md
2026-04-26_<HHmm>.deck.pdf
2026-04-28_<HHmm>.md
2026-04-28_<HHmm>.deck.pdf
```

```
2026-04-28
```

Done. The feature is live. Future every-2-day fires happen automatically.

---

## Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `gate=BLOCKED — only N hours since last run` | The last run succeeded <40h ago. | Either wait, or `rm <vault>/logs/ai_news/last_run_date` to force the next fire. |
| `✗ APIFY_TOKEN missing` | Step 1 incomplete. | Append the key to `~/.openclaw/secrets/bni-masta.env`. |
| `✗ ANTHROPIC_API_KEY missing` | Step 1 incomplete. | Same. |
| `bot LINE: no targets configured` | `LINE_TARGET_GROUP_IDS` empty. | Populate it (Step 1). Empty is allowed but bot leg no-ops. |
| Chrome PDF empty / `CHROME` path error | macOS upgraded and Chrome moved. | Update `CHROME` const in `skills/ai-news-deck/deck.mjs` (mirrors the same const in `skills/meeting-deck-report/deck.mjs` line 14 — keep them in sync). |
| Personal LINE plan written but never delivered | No live Claude Desktop session at trigger time. | Re-trigger with `node skills/ai-news-broadcast/broadcast.mjs --personal-only --run-id <id>` (planned for v1.1) or rely on the next run picking it up. |
