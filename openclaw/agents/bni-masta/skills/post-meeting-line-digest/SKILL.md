---
name: post-meeting-line-digest
description: Send the BNI 副主席 standard post-meeting attendance summary to the operator's LINE after every Friday 例會. Friday-only by default. Idempotent per bot.
metadata:
  openclaw:
    emoji: "📤"
    requires:
      env: [LINE_CHANNEL_ACCESS_TOKEN, ALEX_LINE_ID]
    triggers:
      - "auto-fired by meeting-poll as the LAST step of the post-meeting chain"
      - "/post-meeting-line-digest <YYYY-MM-DD> <bot_id> [--force]"
---

# post-meeting-line-digest

After the post-meeting chain finishes, this skill assembles the chapter's
standard 「每週會後公布夥伴出席狀況」 message and pushes it to the operator's LINE
via the LINE Messaging API.

## Inputs

- `<YYYY-MM-DD>` — meeting date (Taipei wall-clock)
- `<bot_id>` — Vexa bot UUID
- `--force` (optional) — bypasses BOTH the Friday-only gate AND the idempotency marker

## Output (LINE message)

```
<YourChapter>：2026/04/23例會
每週會後公布夥伴出席狀況
應到：35人
實到：32人
代理：1人
遲到：1人
缺席：2人
來賓：1人
-----------------------------
本次例會缺席：2人
058鄭仁偉Johnny
082綠果(事假）
---------------------------
本次例會代理人：1人
064Ryan周侑德 → 代理人：王二-代理人
---------------------------
本次例會遲到：1人
076蕭鉅樺
-----------------------------
本次例會來賓：1人
Justin 李彥岑
```

## Gates

- **Friday-only** — silently skips non-Friday meetings unless `--force`. Writes a `line_digest_sent` marker with `{skipped: "not_friday"}` so meeting-poll doesn't retry.
- **Test-meeting skip** — if `wiki/meetings/<date>.md` has `test: true` / `excluded_from_scoring: true`, skips with `{skipped: "test_meeting"}`.
- **Idempotent** — second invocation for the same `<bot_id>` is a no-op; `--force` overrides.
- **LINE failure** — does NOT block the chain. Marker records `{failed: true, error: …}`.

## Reads

- `raw/roll_calls/<date>.md` — front-matter (counts + substitute / late / absent / visitor lists), authoritative data source
- `wiki/members/*.md` — for each member's `index` (BNI 編號) to render "058姓名" format
- `wiki/meetings/<date>.md` — front-matter to check the test flag (optional, may not exist if ingest-claude hasn't run yet)

## Writes

- `raw/meetings/<date>/<bot_id>.line_digest_sent` — `{sent, at, msg_id}` on success, `{failed, error, at}` on failure, `{skipped: …}` on gate

## Secrets

- `LINE_CHANNEL_ACCESS_TOKEN` from `~/.openclaw/secrets/bni-masta.env`
- `ALEX_LINE_ID` from same env (defaults to `<your-line-user-id>` if missing)

## Implementation

Script: `./digest.mjs`. Run via `node digest.mjs <date> <bot_id> [--force]`.
