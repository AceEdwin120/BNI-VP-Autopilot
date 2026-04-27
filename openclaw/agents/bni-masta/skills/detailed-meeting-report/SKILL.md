---
name: detailed-meeting-report
description: Per-member detailed report of a meeting — rename history, full speech log per member, Haiku-summarized speech bullets. Outputs to vault md + 會議詳情 sheet tab + Speech Log sheet tab.
metadata:
  openclaw:
    emoji: "📊"
    requires:
      env: [OPENROUTER_API_KEY]
    triggers:
      - "auto-fired by meeting-poll after meeting-report"
      - "/detailed-meeting-report <YYYY-MM-DD> <bot_id> [--no-summary] [--force]"
---

# detailed-meeting-report

Generates a per-member detail report combining attendance + speech.

## Why

Standard `meeting-report` is a high-level Claude-compiled summary. This skill
produces granular per-member data that the chapter leadership uses for
follow-up:

- Did each member rename their Zoom display? When? To what?
- Earliest first-join across ALL their participant_ids (handles rejoin from
  multiple devices) — this is the *real* arrival time, used to classify on-time
  vs late.
- All transcript chunks attributable to each member, sorted by time.
- 3-5 bullet Haiku summary of what each member said.

## Outputs

1. `wiki/meeting_reports/<YYYY-MM-DD>_detailed.md` — full report:
   - Stats table at top (應到/實到/全程/遲到/代理/缺席/來賓/Helper)
   - One block per member sorted by 編號
   - One block per visitor / helper (no 編號)

2. Google Sheet `會議詳情` tab — one row per meeting:
   ```
   日期 | 類型 | 應到 | 實到 | 全程 | 遲到 | 代理 | 缺席 | 來賓 | Helper |
   開始(台灣) | 結束(台灣) | 摘要(deep-link to detailed.md)
   ```
   Upserts by date column.

3. Google Sheet `Speech Log` tab — one row per transcript chunk:
   ```
   日期 | 時間(台灣) | 編號 | 會員 | 顯示名稱 | 發言內容
   ```
   Appends new rows; visitors/helpers also captured (編號 blank).

## Identity merge

For each participant_id, walks ALL display names it ever used. If ANY of them
matches a member (via roster-match's lenient logic), tags the pid → member.
If two pids both resolve to the same member (rejoin from a different device),
they're merged: arrival = earliest first_join across pids, leave = latest
last_leave, all speech segments combined.

## Inputs

- `<YYYY-MM-DD>` — meeting date (Taipei)
- `<bot_id>` — Vexa bot UUID
- `--no-summary` — skip per-member Haiku summaries (faster, no LLM cost)
- `--force` — bypass the idempotency marker

## Reads

- `raw/meetings/<date>/participants.jsonl` — full event stream (joins, leaves, renames)
- `raw/meetings/<date>/transcript.jsonl` — per-chunk speech with participant_id
- `raw/roll_calls/<date>.md` — front-matter (counts; absent_members; substitutes)
- `wiki/members/*.md` — for `index` (BNI 編號) + roster matching

## Writes

- `wiki/meeting_reports/<YYYY-MM-DD>_detailed.md`
- Sheet rows (via `gog`)
- `raw/meetings/<date>/<bot_id>.detailed_done` — idempotency marker

## Cost

~$0.001 per member × ~30 active members ≈ $0.03 per meeting on Haiku 4.5.
Negligible.

## Implementation

Script: `./detailed.mjs`. Run via `node detailed.mjs <date> <bot_id> [--force]`.
