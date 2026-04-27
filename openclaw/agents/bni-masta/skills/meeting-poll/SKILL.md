---
name: meeting-poll
description: Periodically polls Vexa for each dispatched bot (raw/meetings/<date>/<bot_id>.bot.json). When a bot transitions to 'done', downloads participant+transcript data, runs resolve-attendance, triggers ingest-claude, and marks the bot as processed. Runs every 60s via LaunchAgent ai.bnimasta.meeting-poll.
metadata:
  openclaw:
    emoji: "⏱️"
    requires:
      bins: [node]
      env: [VEXA_API_KEY]
    triggers:
      - "launchd: every 60s"
      - "/meeting-poll (manual trigger)"
---

# meeting-poll

**Why this exists:** Recall's `realtime_endpoints` webhooks stream participant/transcript events during a meeting, but they do NOT emit a `bot.done` signal when recording finishes. Recall's docs recommend either account-level `status_change` webhooks (requires dashboard setup) or polling. We poll.

## Behavior

Runs every 60 seconds (LaunchAgent `ai.bnimasta.meeting-poll.plist`).

For each `raw/meetings/<date>/<bot_id>.bot.json`:

1. Skip if a sibling file `<bot_id>.done` exists (already processed).
2. GET `https://<region>.vexa/api/v1/bot/<bot_id>/`.
3. If bot's current `status_changes[-1].code` is not `done` → continue (still meeting or joining).
4. If `done`:
   - Download `participant_events` JSON → merge into `participants.jsonl` (normalizes the Recall event list into our flat shape)
   - Download `speaker_timeline.json` → keep for reference
   - Download `participants_list.json` → keep for reference
   - (If transcript media_shortcut is ready) download transcript → `raw/meetings/<date>/transcript.jsonl`
   - Run `resolve-attendance <date>`
   - Run `ingest-claude --scope raw/meetings/<date>`
   - Touch `<bot_id>.done` marker so we don't re-process next run

## Phase lines (per SOUL)

```
▸ polling N bots…
  · bot <id> · still in_call
  · bot <id> · done · downloading artifacts…
  · bot <id> · ✓ resolve-attendance · ingest-claude
✓ meeting-poll tick done (N done, M still active)
```

## Implementation

Script: `./poll.mjs`. Run via `node poll.mjs`.
