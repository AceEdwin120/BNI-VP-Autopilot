---
name: meeting-deck-report
description: Per-meeting HTML/PDF deck report. Builds an interactive deck (Haiku-clustered themes + action items + per-member highlight cards) from the detailed.md, converts to PDF via Chrome headless, uploads PDF to Google Drive (anyone-reader link), and pushes a stats summary + Drive link to the operator's LINE. Friday-only by default.
metadata:
  openclaw:
    emoji: "🎯"
    requires:
      env: [OPENROUTER_API_KEY, LINE_CHANNEL_ACCESS_TOKEN, ALEX_LINE_ID]
    triggers:
      - "auto-fired by meeting-poll after detailed-meeting-report"
      - "/meeting-deck-report <YYYY-MM-DD> <bot_id> [--force] [--no-line]"
---

# meeting-deck-report

After every Friday meeting, build a beautiful interactive deck of what
happened, save it to the vault, share via Google Drive, and notify the operator on
LINE. Replaces the older `post-meeting-line-digest` (BNI 副主席 standard
template) which is now superseded by this richer single-message + deck.

## Outputs

1. `wiki/meeting_reports/<YYYY-MM-DD>_deck.html` — interactive HTML deck (single-file, keyboard-navigable, dark theme, prefers-reduced-motion respected, `@media print` rules baked in)
2. `wiki/meeting_reports/<YYYY-MM-DD>_deck.pdf` — Chrome-headless render of the deck (one slide per page)
3. Google Drive: PDF uploaded under `BNI-Masta-Reports/` folder (auto-created if missing), shared as anyone-reader, link captured
4. LINE message #1 (text, ~200 chars): stats-only summary
   ```
   📊 <YourChapter> <date> 例會總結
   應到 N / 實到 N / 全程 N / 遲到 N / 早退 N / 缺席 N / 來賓 N / Helper N
   ❌ 缺席 (N): name1、name2、…
   👥 來賓 (N): …
   🤝 Helper (N): …
   ```
5. LINE message #2 (text, ~150 chars): the Drive PDF link
   ```
   📎 完整報告 (PDF):
   https://drive.google.com/file/d/<id>/view
   ```

## Inputs

- `<YYYY-MM-DD>` — meeting date (Taipei)
- `<bot_id>` — Vexa bot UUID
- `--force` — bypass BOTH the Friday-only gate AND the idempotency marker
- `--no-line` — skip LINE push (just save HTML+PDF to vault, upload to Drive)

## Reads

- `wiki/meeting_reports/<date>_detailed.md` — Haiku per-member bullets (must exist; produced by `detailed-meeting-report`)
- `raw/roll_calls/<date>.md` — counts + lists in front-matter

## Writes

- `wiki/meeting_reports/<date>_deck.html`
- `wiki/meeting_reports/<date>_deck.pdf`
- Google Drive file (with anyone-reader sharing)
- `raw/meetings/<date>/<bot_id>.deck_done` — idempotency marker

## Gates

- **Friday-only** by default (`--force` bypasses)
- **Idempotent** (second run for same `<bot_id>` is a no-op unless `--force`)
- **Skips test meetings** (when `wiki/meetings/<date>.md` has `test: true`)

## Cost per run

- 2 × Haiku calls (cluster themes + extract actions): ~$0.005
- Chrome headless PDF: $0
- Google Drive upload: $0 (under 15 GB free quota)
- LINE Messaging API push: $0 (free for owned channels)
- **Total: ~$0.005 per Friday meeting**

## Dependencies

- `OPENROUTER_API_KEY` (Haiku 4.5)
- `LINE_CHANNEL_ACCESS_TOKEN` + `ALEX_LINE_ID`
- `gog` CLI (for Drive upload + share) under `<your-google-account>`
- Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `pdftoppm` (poppler) — installed already, used by other skills too (not strictly needed here since we use Chrome PDF)

## Implementation

Script: `./deck.mjs`. Run via `node deck.mjs <date> <bot_id> [--force] [--no-line]`.
