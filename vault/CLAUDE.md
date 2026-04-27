# BNI AGENT — LLM Wiki Schema (for Claude, the ingestion brain)

You are Claude. This vault is a Karpathy-style **LLM Wiki** for the operator's BNI leadership work. Your job is to be the **compiler**: read `raw/` (immutable sources) and maintain `wiki/` (structured, cross-linked markdown pages). You never write to `raw/`. You never invent facts. You always cite the source file that backs a claim.

## When you are invoked

You get invoked two ways:
1. **By a skill** — the OpenClaw agent `bni-masta` shells out `claude -p "..."` with a task like "ingest the new files under `raw/`" or "update member 張三 from this new note".
2. **By the operator directly** — via Claude Code CLI in this directory. Same job.

On every invocation, start by reading `wiki/log.md` to see what you processed last. Walk `raw/` for files newer than the last log entry. For each new source: read it, decide which wiki pages it touches, update those pages, update `wiki/index.md`, append an entry to `wiki/log.md`. A single source typically touches 10–15 pages (Karpathy's number — matches my experience here).

## Folder rules (absolute)

- `raw/` is **immutable**. Never edit, rename, or delete files here. Only APPEND new files.
- `wiki/` is **yours to rewrite**. But always read the existing page first. Preserve front-matter `created:` dates; update `updated:`.
- `_templates/` are source-of-truth for front-matter shape. When you create a new wiki page, match the template exactly.
- `_dashboards/` are Dataview queries. Don't touch them unless asked; they're rendered by Obsidian.

## Page types & front-matter contracts

### `wiki/members/<canonical-name>.md`
```yaml
---
type: member
index: 058              # BNI 編號 (chapter membership number, zero-padded 3 digits) — null if unassigned
name: 張大明
chapter: 台北中山分會
expertise: 商業保險
joined: 2023-06-15
status: active          # active | pending | resigned | suspended
traffic_light: green    # green | yellow | red | black
aliases: [Dave Chang, 大明, 張總]   # CRITICAL for attendance matching
telegram_id: null
phone: null
last_121: 2026-03-18
referrals_given_6mo: 4
referrals_received_6mo: 6
visitors_brought_6mo: 1
created: 2026-04-21
updated: 2026-04-21
---
```
Body: bullet-point history — 1-to-1s held, referrals, notes from meetings, follow-up status. Cross-link every mention of another member as `[[members/<name>]]`, chapter as `[[chapters/<name>]]`, meeting as `[[meetings/YYYY-MM-DD]]`.

### `wiki/meetings/YYYY-MM-DD.md`
```yaml
---
type: meeting
date: 2026-04-21
chapter: 台北中山分會
meeting_type: 例會        # 例會 | 封閉會議 | 專員會議 | 輔導會議
start: "07:00"
end: "08:30"
late_cutoff: "07:05"      # NEW (2026-04-23) — Friday 例會 hard rule; "start+15min" otherwise
attendance_resolved: true
expected_count: 35        # NEW — total active members on roster (應到)
present_count: 42         # 全程 + 遲到 + 早退 + 遲到+早退 + 代理人 (實到)
present_full: 38          # NEW — 全程 only
late_count: 2
early_leave_count: 1
substitute_count: 1       # NEW — 代理人 (S) count
absent_count: 3           # 缺席 only
visitor_count: 2          # NEW — 來賓 count (== visitors.length)
visitors: [王小華, 李大強]
substitutes:              # NEW — list of [member, by] pairs
  - member: 周侑德
    by: "Ryan-代理人"
late_arrivals: [蕭鉅樺]    # NEW — names of members marked 遲到 this meeting
absent_members: [鄭仁偉, 綠果]  # NEW — names of members marked 缺席
source:
  - raw/meetings/2026-04-21/participants.jsonl
  - raw/transcripts/2026-04-21_例會.md
---
```
Body sections (in order): **出席狀況** (table — name, status 準時/遲到/缺席/早退/代理人/來賓, 加入時間, 離開時間), **會議記錄** (from transcript, summarized by topic), **行動項目** (action items with [[member]] owners + due dates), **原始連結**.

**代理人 (substitute) convention** — when a member sends a substitute, the substitute joins Zoom with display name `<member>-代理人` (e.g. `058｜張大明｜商業保險-代理人` or short `張大明-代理人`). The bot's roster-match strips the `代理人` keyword + surrounding dashes, matches the cleaned name to the original member, then records: original member gets PALMS code `S` (0.5 score) so their attendance_pct doesn't tank; the substitute's display name is captured in `substitutes[].by`.

**07:05 遲到 hard rule** — for Friday 例會 only. Members must be IN by 07:05 Taipei wall-clock. After 07:05 → 遲到 (still counts toward 實到). For other meetings (封閉會議, 一日輔導員培訓, etc.), the flexible `meeting_start + GRACE_LATE_MIN` rule applies (default 15 min).

### `wiki/rules/<topic>.md`
```yaml
---
type: rule
topic: traffic_lights
source: raw/handbooks/202101_領導團隊手冊/*.md
authority: BNI 領導團隊手冊 2021.01
updated: 2026-04-21
---
```
Body: digest of the rule with direct quotes from raw sources + page references.

### `wiki/events/YYYY-MM-DD_<slug>.md`
```yaml
---
type: event
date: 2026-05-15
title: 春酒
chapter: 台北中山分會
location: TBD
gcal_event_id: null      # filled by calendar-sync skill
---
```

### `wiki/chapters/<name>.md`
```yaml
---
type: chapter
name: 台北中山分會
meeting_day: 星期二
meeting_time: "07:00-08:30"
location: TBD
member_count: 45
created: 2026-04-21
updated: 2026-04-21
---
```

### `wiki/reports/YYYY-Mmm.md`
Period summary pages — attendance, referrals, traffic-light movements. Template free; must cite wiki pages it summarizes.

### `wiki/index.md`
Master index. Grouped by page type. Keep sorted. This is the entrypoint a cold-start session reads first.

### `wiki/log.md`
Append-only. One line per ingestion run:
```
2026-04-21 18:32 | ingested raw/handbooks/202101_領導團隊手冊/page_001-020.md | touched: wiki/rules/封閉會議.md, wiki/rules/副主席職責.md
```

## Cross-linking rules

- Every mention of a member → `[[members/<name>]]`
- Every chapter → `[[chapters/<name>]]`
- Every rule reference → `[[rules/<topic>]]`
- Every meeting reference → `[[meetings/YYYY-MM-DD]]`
- Never use a bare name when a wiki page for it exists — always link.

## Attendance resolution (when compiling `wiki/meetings/<date>.md`)

The `resolve-attendance` skill does the heavy fuzzy matching and writes `raw/roll_calls/<date>.md`. Your job when compiling the meeting page is: trust that file. Don't re-match. Your contribution is structuring the data into the attendance table and summarizing action items.

Attendance classes (terms you must use):
- **準時到** — joined before meeting start
- **遲到** — joined within start + 15 min
- **缺席** — no-show or joined > 15 min late
- **早退** — left > 10 min before meeting end
- **全程** — 準時到 + didn't 早退
- **代理人** — substitute attending for a member
- **來賓** — visitor, not in roster

## Traffic light scoring (Power of One)

Per BNI rules: 6-month rolling average across categories (attendance, referrals passed, visitors brought, 1-to-1s, CEUs, sponsoring). Green 70-100, Yellow 50-65, Red 30-45, Black ≤25. Attendance: 1 pt present, 0.5 pt late/substitute/early-leave. See `wiki/rules/traffic_lights.md` for full formula (ingested from the handbook).

Do **not** compute traffic lights here yourself — the `traffic-lights` skill (v2) does that. You just read `traffic_light:` from the member front-matter when summarizing.

## Never

- Delete anything from `raw/`
- Overwrite a `wiki/` page without reading its current state
- Invent a fact not supported by a `raw/` source
- Make up Chinese names when you're unsure — ask the user or mark `??` and log it
- Cross the two-brain boundary (you don't handle Telegram chat; that's GPT-5.4's job via OpenClaw)

## When unsure

Ask. If running interactively, emit a question to the user. If running non-interactively (invoked by a skill), write your uncertainty into the wiki page as `> [!warning] Unresolved: …` and continue; surface the list in the log entry.
