---
name: roster-sync
description: Sync member CRM from wiki/members/*.md to the operator's Google Sheet (會員名單 + 紅綠燈 tabs). Upserts by name. Runs on demand via /roster-sync or weekly via launchd.
metadata:
  openclaw:
    emoji: "📊"
    requires:
      bins: [gog]
    triggers:
      - "/roster-sync"
      - "weekly cron Sun 22:00 via ai.bnimasta.roster-sync LaunchAgent"
---

# roster-sync

**Two-way sync** between `wiki/members/*.md` and the BNI Google Sheet:
**https://docs.google.com/spreadsheets/d/<your-google-sheet-id>/edit**

Two tabs are maintained (created on first run if missing):

| Tab | Columns |
|---|---|
| `<YourChapter>會員名單` | 姓名 · 專業 · 分會 · 加入日 · 狀態 · 出席率(%) · 電話 · Email · 最近更新 |
| `紅綠燈` | 姓名 · 燈號 · 總分 · 轉介(給) · 轉介(收) · 來賓帶入 · 1-to-1 · CEU · 贊助(6M) |

## Inputs

- `sheet_id` (default `<your-google-sheet-id>`)
- `account` (default `<your-google-account>`)

## Behavior

1. List every `.md` file in `wiki/members/`; parse YAML front-matter.
2. Read existing rows from `會員名單!A2:A` to build a name→rowIndex map (for upsert).
3. For each member:
   - Compute 總分 and 燈號 from Power of One categories if all raw fields present; else leave 總分 blank and 燈號 = member's stored `traffic_light:` value.
   - Update the existing row (if name found) or append.
4. Phase-report per SOUL: `▸ syncing <N> members… · ✓ <M> updated · <K> appended`.

## Scoring (v1 approximation)

Power of One formula — 6-month rolling, max 100:

| Category | Field | Weight | Cap |
|---|---|---|---|
| 出席 | `attendance_pct` | 0.30 | 30 |
| 轉介 (給) | `referrals_given_6mo × 3` | 1.0 | 20 |
| 轉介 (收) | `referrals_received_6mo × 2` | 1.0 | 15 |
| 來賓帶入 | `visitors_brought_6mo × 5` | 1.0 | 10 |
| 1-to-1 | `ones_6mo × 2` | 1.0 | 10 |
| CEU | `ceu_count_6mo × 2` | 1.0 | 10 |
| 贊助 | `sponsoring_count_6mo × 5` | 1.0 | 5 |

Colors (per [[rules/traffic_lights]]):

- 綠 🟢 70–100
- 黃 🟡 50–69
- 紅 🔴 30–49
- 黑 ⚫ ≤29

## Implementation

Script: `./sync.mjs`. Run via `node sync.mjs`.

Env / defaults: reads `BNI_ROSTER_SHEET_ID` and `BNI_ROSTER_ACCOUNT` from `~/.openclaw/secrets/bni-masta.env`; falls back to the hardcoded defaults.

## Failure modes

- No members yet → writes headers only, reports `✓ 0 members (roster is empty)`.
- `gog` not authed → `✗ gog not authed — run: gog auth add <your-google-account> --services sheets`.
- Network error → retries once with 5s backoff, then fails with the exact error.
