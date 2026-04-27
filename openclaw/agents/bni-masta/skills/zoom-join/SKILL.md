---
name: zoom-join
description: Send a Vexa bot named "BNI-Masta" to join a Zoom meeting and capture audio, video, participant events, and transcript. Use when the operator is attending a meeting hosted by someone else.
metadata:
  openclaw:
    emoji: "🤖"
    requires:
      env: [VEXA_API_KEY]
    triggers:
      - "/zoom-join <url_or_id> <pwd>"
      - "the operator pastes a Zoom link"
---

# zoom-join

Dispatches a Vexa participant bot to a Zoom meeting. Vexa handles the hard parts: joining as a participant, recording audio+video, producing speaker-diarized transcripts, emitting participant join/leave events. Webhooks fire at `~/.openclaw/agents/bni-masta/services/vexa-webhook.mjs` which writes raw files and auto-triggers `resolve-attendance` + `ingest-claude`.

## Inputs

- `meeting_url` — full Zoom link OR 11-digit meeting ID
- `meeting_password` — optional if the link embeds pwd, required if standalone ID
- `scheduled_start` (optional ISO) — if the meeting is in the future; defaults to now
- `meeting_title` (optional) — e.g., "2026-04-22 封閉會議"; defaults to `今日會議 <YYYY-MM-DD>`

## Behavior

1. Normalize: if the operator pasted a `https://zoom.us/j/12345?pwd=...` URL, extract pwd from it.
2. POST to `https://us-west-2.vexa/api/v2/bot/` with:
   ```json
   {
     "meeting_url": "https://zoom.us/j/12345?pwd=...",
     "bot_name": "BNI-Masta",
     "recording_config": {
       "transcript": { "provider": { "meeting_captions": {} } },
       "participant_events": { "events": ["speech", "participant_join", "participant_leave", "rename"] },
       "video_mixed_layout": "gallery_view_v2"
     },
     "webhook_url": "https://<your-ngrok-domain>/vexa-webhook"
   }
   ```
3. Save the returned `bot.id` to `raw/meetings/<date>/<bot_id>.bot.json` so webhooks can be correlated.
4. Emit phase line per SOUL: `✓ bot dispatched · waiting on meeting` — no future-tense "I'll ping you" preamble. The webhook will fire its own `✓ transcript ready` line when Vexa returns data.

## Notes

- Recall costs ~$0.50/hr of meeting. Free tier covers initial testing.
- `webhook_url` must be public — for dev use `ngrok http 18821` and update this value.
- Prod: Cloudflare Tunnel to `~/.openclaw/agents/bni-masta/services/vexa-webhook.mjs` on port 18821.

## Implementation

Script: `./dispatch.mjs`. Run via `node dispatch.mjs <url> [pwd] [title]`.
