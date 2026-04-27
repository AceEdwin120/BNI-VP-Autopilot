---
name: post-meeting-digest
description: Send a Telegram digest to the operator summarizing a finished BNI meeting (attendance, summary, action items, pipeline status). Friday-only by default. Idempotent per bot.
metadata:
  openclaw:
    emoji: "📤"
    requires:
      env: [ALEX_TELEGRAM_ID]
    triggers:
      - "auto-fired by meeting-poll as the last step of the post-meeting chain"
      - "/post-meeting-digest <YYYY-MM-DD> <bot_id> [--force]"
---

# post-meeting-digest

Builds a compact Telegram message after the post-meeting chain (resolve →
ingest → report → sheet → roster_sync) finishes for a given bot, and POSTs it
to the operator via `<your-telegram-alert-bot>`.

## Inputs

- `<YYYY-MM-DD>` — meeting date (Taipei)
- `<bot_id>` — Vexa bot UUID
- `--force` (optional) — bypass the Friday-only gate AND the idempotency marker

## Output (Telegram message)

```
📋 會議結束 · 2026-04-22 · 例會
🧪 測試會議        ← only if test:true / excluded_from_scoring:true

📊 ✓ 點名 · ✓ 編譯 · ✓ 報告 · ⏭ Sheet · ✓ 名冊

👥 出席（35 位）
遲到 0 · 缺席 0 · 早退 0 · 來賓 2

📝 摘要
（first prose paragraph from wiki/meeting_reports/<date>.md, ≤250 chars）

🎯 行動項目（5+）
- ✅ <YourName> 寄送本週引薦表給導師團
- ✅ <MemberName> 跟進 ABC 公司 visitor follow-up
- ✅ ...

🔗 連結
· [會議頁面](obsidian://open?vault=BNI%20AGENT&file=wiki%2Fmeetings%2F2026-04-22)
· [會議報告](obsidian://open?vault=BNI%20AGENT&file=wiki%2Fmeeting_reports%2F2026-04-22)
· [出席表](https://docs.google.com/spreadsheets/d/<sheet_id>/edit)
```

## Gates

- **Friday-only** — silently skips non-Friday meetings unless `--force`. Writes a `digest_sent` marker with `{skipped: "not_friday"}` so meeting-poll doesn't retry.
- **Idempotent** — second invocation for the same `<bot_id>` is a no-op; `--force` overrides.
- **Telegram failure** — does NOT block the chain. Marker records `{failed: true, error: …}`; meeting-poll continues.

## Reads

- `raw/meetings/<date>/<bot_id>.done` — pipeline status flags
- `wiki/meetings/<date>.md` — front-matter (counts, type, test flag)
- `wiki/meeting_reports/<date>.md` — body (summary + action items)

## Writes

- `raw/meetings/<date>/<bot_id>.digest_sent` — `{sent: true, at, msg_id}` on success, `{failed, error, at}` on failure, `{skipped: "not_friday"}` on weekday skip

## Secrets

- Bot token: read from `~/.openclaw/openclaw.json` (`channels.telegram.accounts.bnimasta.botToken`) — falls back to env `BNI_TELEGRAM_BOT_TOKEN` if set
- Chat ID: env `ALEX_TELEGRAM_ID` (configured in `~/.openclaw/secrets/bni-masta.env`)
