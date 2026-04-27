---
name: personal-line-broadcast
description: The **Post-meeting LinePc Pipeline** (Pipeline #2). Builds the broadcast plan (target groups + stats + Drive PDF link) for delivery via Computer Use → LINE for Mac, using the operator's personal LINE account. Workaround for groups that already have another Official Account installed (LINE only allows 1 OA per group). Friday-only steady state. Idempotent. Per-target failure isolation.
metadata:
  openclaw:
    emoji: "📣"
    requires:
      app: ["/Applications/LINE.app"]
      env: [BNI_PERSONAL_LINE_TARGETS, BNI_PERSONAL_LINE_TEST_TARGETS, BNI_PERSONAL_LINE_MODE]
      runtime: "claude-desktop-computer-use"
    triggers:
      - "manual: node broadcast.mjs <YYYY-MM-DD> <bot_id> [--force] [--dry-run]"
      - "executor: a Claude Desktop session reads the JSON plan and drives LINE.app via Computer Use"
---

# personal-line-broadcast — Post-meeting LinePc Pipeline (Pipeline #2)

This is the **second post-meeting pipeline**, parallel to the autonomous Post-meeting Pipeline (#1).

| | Pipeline #1 — Post-meeting | Pipeline #2 — Post-meeting LinePc (this one) |
|---|---|---|
| Trigger | `meeting-poll` LaunchAgent on Vexa bot.done | Claude Desktop session, manual or scheduled |
| Channel | Bot account `<your-line-bot-id>` via LINE Messaging API | Operator's personal LINE account via LINE for Mac |
| Reach | Bot's DMs + groups bot is in | Any group personal account is in (incl. groups with 1-OA conflict) |
| Runtime | Node + LaunchAgent | Node planner + Claude Desktop Computer Use executor |

## Why two parts (planner + executor)

The skill is split deliberately:

1. **Planner (`broadcast.mjs`)** — pure CLI script. Validates gates, resolves targets, builds the 2-message payload from prior pipeline outputs, emits a JSON plan to stdout. No desktop side effects. Idempotent because exit code 12 short-circuits successful prior runs.
2. **Executor — a Claude Desktop session** with Computer Use. Reads the planner's JSON, opens LINE.app, sends each message to each target, then calls the planner again with `--mark-done '<results-json>'` to record outcomes.

Why not AppleScript? Tried and abandoned — macOS Sequoia's TCC denies System Events keystrokes from `osascript` regardless of how osascript / Terminal / node is granted Accessibility (`不允許「osascript」傳送按鍵 (1002)`). Computer Use is the surviving UI-driven path. See SKILL.md for the full investigation.

## CLI

```bash
# Plan mode
node broadcast.mjs <YYYY-MM-DD> <bot_id> [--force] [--dry-run]

# Mark mode
node broadcast.mjs <YYYY-MM-DD> <bot_id> --mark-done '<results-json>' [--dry-run]
```

### Inputs

- `<YYYY-MM-DD>` — meeting date (Taipei timezone)
- `<bot_id>` — Vexa bot UUID; used to find the deck-done marker
- `--force` — bypass Friday-only gate AND idempotency marker
- `--dry-run` — plan a single literal `OK` payload to test target only

### Plan exit codes

| Code | Meaning |
|---|---|
| 0  | plan emitted to stdout |
| 1  | error (missing roll_call, missing deck_done, etc.) |
| 2  | bad usage |
| 10 | skipped — not Friday (use `--force`) |
| 11 | skipped — meeting marked `test: true` |
| 12 | skipped — already broadcast successfully |

A prior failed run is NOT a skip — the planner detects partial/failed prior results and replans without `--force`.

## Targets

Three resolution modes. The planner picks one based on flags + env:

| Selector | Targets | Payload |
|---|---|---|
| `--dry-run` | `BNI_PERSONAL_LINE_TEST_TARGETS` (default `<YourTestGroup>`) | literal `OK` |
| `BNI_PERSONAL_LINE_MODE=test` (default) | `BNI_PERSONAL_LINE_TEST_TARGETS` | real (stats + PDF link) |
| `BNI_PERSONAL_LINE_MODE=production` | `BNI_PERSONAL_LINE_TARGETS` | real (stats + PDF link) |

Env (in `~/.openclaw/secrets/bni-masta.env`):

```
BNI_PERSONAL_LINE_TARGETS=<YourTestGroup>,<YourCrossChapterVPGroup>
BNI_PERSONAL_LINE_TEST_TARGETS=<YourTestGroup>
BNI_PERSONAL_LINE_MODE=test
BNI_PERSONAL_LINE_DELAY_MS=1500
```

Group names are matched against LINE's quick-search — first result wins. If multiple chats share a prefix, use the unique full name.

## Reads

- `raw/roll_calls/<date>.md` — front-matter (PALMS counts + per-bucket member lists)
- `raw/meetings/<date>/<bot_id>.deck_done` — Drive URL written by `meeting-deck-report` (step 9 of Pipeline #1)
- `wiki/meetings/<date>.md` (optional) — checked for `test: true`
- `BNI_VAULT_DIR` env (optional) — overrides default vault path

## Writes

- `raw/meetings/<date>/<bot_id>.personal_line_done` — idempotency marker, written by `--mark-done`

## Plan JSON shape

```jsonc
{
  "skill": "personal-line-broadcast",
  "pipeline": "post-meeting-linpc",
  "runtime": "computer-use",
  "date": "2026-04-24",
  "botId": "<your-bot-id>",
  "mode": "test",
  "payloadKind": "test",          // "dry-run" | "test" | "production"
  "targets": ["<YourTestGroup>"],
  "messages": [
    "📊 <YourChapter> 2026-04-24 例會總結\n應到 35 / 實到 31 / …",
    "📎 完整報告 (PDF):\nhttps://drive.google.com/file/d/…"
  ],
  "markerPath": "<vault-path>/raw/meetings/2026-04-24/<your-bot-id>.personal_line_done",
  "sendGapMs": 1500,
  "instructions": ["Computer Use executor (Claude Desktop session):", "..."]
}
```

## --mark-done JSON shape

Pass an array of per-target results:

```jsonc
[
  { "target": "<YourTestGroup>",
    "ok": true,
    "messages": [{ "idx": 1, "ok": true }, { "idx": 2, "ok": true }] },
  { "target": "<YourCrossChapterVPGroup>",
    "ok": false,
    "error": "search returned no results" }
]
```

Marker exit code: 0 if every target ok, 1 otherwise. The marker file always reflects the per-target truth, success or failure.

## End-to-end example (Claude Desktop, dry-run)

```bash
# 1. Plan (CLI, on a Friday meeting)
node ~/.openclaw/agents/bni-masta/agent/skills/personal-line-broadcast/broadcast.mjs \
     2026-04-24 <your-bot-id> --force --dry-run

# 2. Claude Desktop session captures the JSON, then for each target:
#      request_access(["LINE"])
#      open_application("LINE")
#      left_click search field → type group name → click matching row
#      left_click input box → for each message: type → press Return → wait sendGapMs

# 3. Mark
node ~/.openclaw/agents/bni-masta/agent/skills/personal-line-broadcast/broadcast.mjs \
     2026-04-24 <your-bot-id> --mark-done \
     '[{"target":"<YourTestGroup>","ok":true,"messages":[{"idx":1,"ok":true}]}]' \
     --dry-run
```

## Cost per run

$0 — no LLM, no API calls. Only macOS UI automation via Computer Use.

## Production wiring

NOT auto-triggered by `meeting-poll` LaunchAgent — Computer Use requires a live Claude Desktop session. Intended trigger model:

- Friday after Pipeline #1 finishes step 9 (`meeting-deck-report` writes `<bot_id>.deck_done`), open Claude Desktop and ask: *"Run personal-line-broadcast for the latest meeting"*. Claude Desktop runs the planner, executes via Computer Use, calls `--mark-done`. Or schedule that prompt via Claude Desktop's scheduling.

## Safety

- Idempotency: successful prior marker → skip without `--force`
- Test-meeting skip: `wiki/meetings/<date>.md` with `test: true` is excluded by default
- Friday-only: only Fridays run by default
- `--dry-run`: never sends real content; touches only `BNI_PERSONAL_LINE_TEST_TARGETS`
- `MODE=test` (default): real payload but only test targets — production targets stay untouched
- Per-target try/catch: one bad group does not stop the rest (executor responsibility)
- The executor saves + restores clipboard (executor responsibility — see Computer Use teardown)

## Dependencies

- `LINE.app` installed at `/Applications/LINE.app`, logged into the operator's personal account
- Node 18+ (for the planner)
- A Claude Desktop session with Computer Use enabled (for the executor)
