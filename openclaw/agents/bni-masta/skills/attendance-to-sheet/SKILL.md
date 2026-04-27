---
name: attendance-to-sheet
description: After resolve-attendance writes raw/roll_calls/<date>.md, this skill converts each member's status to a PALMS code and updates (a) the 出席紀錄 tab's column for that date, and (b) each member's attendance counters in wiki/members/*.md front-matter. Auto-fires in meeting-poll after meeting-report. Manual trigger / attendance-to-sheet <YYYY-MM-DD>.
metadata:
  openclaw:
    emoji: "📋"
    requires:
      bins: [gog, node]
      env: [BNI_ROSTER_SHEET_ID, BNI_ROSTER_ACCOUNT]
    triggers:
      - "auto-chained after meeting-report in meeting-poll"
      - "/attendance-to-sheet <YYYY-MM-DD>"
---

# attendance-to-sheet

Bridges `raw/roll_calls/<date>.md` → Google Sheet 出席紀錄 tab + member front-matter counters.

## Status → PALMS code mapping

Per [[rules/點名規則]]:

| 解析狀態 | PALMS | 分數 |
|---|---|---|
| 全程 / 準時到 | `P` | 1.0 |
| 遲到 | `L` | 0.5 |
| 缺席 | `A` | 0.0 |
| 早退 (alone) | `E` | 0.5 |
| 遲到+早退 | `LE` | 0.25 |
| 代理人 | `S` | 0.5 |
| 來賓 | — (not a member; not recorded in this tab) |

## Behavior

1. Read `raw/roll_calls/<date>.md` — parse the attendance table.
2. Skip rows flagged `test: true` or `excluded_from_scoring: true` in the roll_call front-matter — they don't mutate anything.
3. For each row with a member (`[[members/<name>]]`):
   - Compute PALMS code from status
   - Update Google Sheet 出席紀錄 at `<member_row>!<date_column>` via `gog`
     - If `<date>` isn't an existing column header, append it as a new column (rightmost)
4. For each member: increment their `attendance_pct` counter in front-matter:
   - Compute as rolling-6-meeting avg of PALMS score × 100. Store to 1 decimal.
   - Also bump `_last_meeting_present` / `_last_meeting_late` fields as appropriate
5. Appends one line to `wiki/log.md` describing what was updated.

## Idempotency

Writes a sibling marker `raw/roll_calls/<date>.sheet-updated` after success. Re-running will detect it and exit cleanly (unless `--force` passed).

## Output

- Google Sheet 出席紀錄 tab: updated PALMS cell
- `wiki/members/<name>.md` front-matter: updated `attendance_pct`
- `wiki/log.md` entry
- `raw/roll_calls/<date>.sheet-updated` (marker)

## Failure modes

- Sheet unreachable → skip sheet update, still updates vault, logs error
- Date column missing → auto-appends rightmost
- Member not in sheet's 出席紀錄 tab → auto-appends a new row for them
- Empty roll_call → exits cleanly with no writes

## Implementation

Script: `./update.mjs`. Run via `node update.mjs <YYYY-MM-DD> [--force]`.
