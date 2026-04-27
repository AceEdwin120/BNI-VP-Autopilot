---
name: resolve-attendance
description: Match Vexa raw participant events against the member roster using exact → fuzzy → LLM arbitration, classify each attendance as 準時到/遲到/缺席/早退/全程/代理人/來賓, and write raw/roll_calls/<date>.md. Runs automatically after the Vexa webhook signals meeting end.
metadata:
  openclaw:
    emoji: "🪪"
    requires:
      bins: [claude]
    triggers:
      - "Vexa webhook bot.done event"
      - "/resolve-attendance <date>"
---

# resolve-attendance

Take Vexa's raw `participants.jsonl` + the member roster in `wiki/members/*.md` and produce a clean attendance table.

## Inputs

- `date` — meeting date (YYYY-MM-DD); finds `raw/meetings/<date>/participants.jsonl`
- `meeting_start` (optional) — ISO; if omitted, read from the `.bot.json` manifest or infer from first join event
- `meeting_end` (optional) — ISO; if omitted, read from `bot.done_at` or last leave event
- `grace_late_min` — default 15 (minutes after start where "late" cutoff sits)
- `grace_early_leave_min` — default 10 (minutes before end where "early leave" cutoff sits)

## Three-tier matching

Each participant's (last observed) display name runs through:

1. **Exact** against each `wiki/members/*.md` front-matter `name` or any entry in `aliases: [...]`.
2. **Fuzzy** (RapidFuzz via `fastest-levenshtein` npm pkg — we ship it inline): token_sort_ratio ≥ 85 → match.
3. **LLM arbitration** (shell out to `claude --print` with the roster slice + display name): must return a member id or `NONE`.

If no tier resolves → tagged as `來賓` and appended to `raw/visitors/<date>.jsonl` for later promotion.

## Classification

- `準時到` — first join ≤ meeting_start
- `遲到` — first join within [meeting_start, meeting_start + grace_late_min]
- `缺席` — no join event, OR first join > meeting_start + grace_late_min
- `早退` — last leave < meeting_end - grace_early_leave_min
- `全程` — 準時到 AND NOT 早退
- `代理人` — flagged via alias convention (e.g. alias prefixed `代:`) or explicit `/substitute` command
- `來賓` — unmatched name, not a substitute

## Output

`raw/roll_calls/<date>.md`:
```markdown
---
type: roll_call
date: 2026-04-21
meeting_start: "2026-04-21T07:00:00+08:00"
meeting_end: "2026-04-21T08:30:00+08:00"
source: raw/meetings/2026-04-21/participants.jsonl
resolved_at: 2026-04-21T08:45:00+08:00
---

| 會員 | 狀態 | 顯示名稱 | 加入時間 | 離開時間 | 發言秒數 | 匹配來源 |
|---|---|---|---|---|---|---|
| [[members/張大明]] | 準時到 | Dave | 07:00:12 | 08:30:02 | 312 | alias |
| — | 來賓 | 王小華 | 07:04:18 | 08:29:50 | 0 | unmatched |
```

## Implementation

Script: `./resolve.mjs`. Run via `node resolve.mjs <date>`.
