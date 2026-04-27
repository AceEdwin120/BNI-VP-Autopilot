---
name: meeting-report
description: Structured meeting report with BNI-agenda-aware sections. Branches by meeting_type (例會 / 封閉會議 / 專員會議 / 測試). Robust to skipped items — only renders sections that actually happened, flags expected-but-missing items. Side-effect: extracts 業務引薦 table into raw/inbox/referrals_<date>.jsonl for CRM sync. Auto-fires after every meeting via meeting-poll; manual via /meeting-report <YYYY-MM-DD>.
metadata:
  openclaw:
    emoji: "📝"
    requires:
      bins: [claude]
    triggers:
      - "auto-chained after ingest-claude in meeting-poll"
      - "/meeting-report <YYYY-MM-DD>"
---

# meeting-report

Produces `wiki/meeting_reports/<date>.md` AND `raw/inbox/referrals_<date>.jsonl` (CRM feeder). Structure mirrors BNI's standard agenda per [[rules/會議議程]] and [[rules/封閉會議]] so the report aligns with how meetings actually run.

## Template selection

The skill reads `meeting_type:` from `wiki/meetings/<date>.md` and chooses one of three templates:

### 1. 例會 (weekly regular meeting) — 20-item BNI agenda

Sections rendered in this order (each skipped if no transcript content supports it):

```
## 開場（0:00–0:14）
  - 本週核心價值：…
  - 教育單元主題：…
  - 領先人物：… (if 每月第二次會議)

## 新會員宣誓 / 續約（0:14–0:16）
  - only if someone was inducted/renewed

## 60 秒簡報（0:16–0:49）
  - one ### per member who pitched, with:
    - 本週主軸
    - 客戶痛點 / 目標市場
    - 引薦指令 (specific ask)

## 來賓自我介紹（0:49–0:51）
  - only if 來賓 attended

## 副主席報告 + 會員委員會報告（0:51–0:53）
  - announcements, committee updates

## 秘書財務宣佈（0:53–0:54）

## 主題簡報（0:54–1:04）
  - 講者 / 主題 / 目標市場 / 引薦指令 / 關鍵內容 3-5 bullets

## 業務引薦 · 見證 · 嘉賓心得（1:04–1:22）
  - table: 時間 | 引薦人 | 被引薦人 | 引薦內容 | 預期金額
  - plus verbal testimonials + visitor impressions

## 查核業務引薦（1:22–1:24）
  - 副主席 checks 2 referrals from prior 2 weeks

## 秘書財務報告（1:24–1:26）

## 公告 · 抽獎 · 閉幕（1:26–1:30）
```

### 2. 封閉會議 (monthly closed meeting) — Claude detects sub-type

Based on transcript content, Claude identifies which of the 4 sub-types per [[rules/封閉會議]]:

- **接待組會議** → 來賓跟進 / 來賓數量質量 / 轉換率提升
- **導師團會議** → 會員輔導紀錄 / 紅綠燈檢視 / 導師報告總結
- **會員委員會會議** → PALMS 出缺席 / 引薦狀況 / 續約與輔導 / 當責信 / 觀察期 / 專業別
- **領導團隊月會** → 分會目標 / 各組別總結報告 / 會員紅綠燈 / 分會活動

Each sub-type has its own section skeleton.

### 3. Other (測試 / 專員會議 / 輔導會議 / unknown) — flat per-speaker

Falls back to v1 layout: 會議摘要 + 關鍵決議 + 行動項目 + 各位發言重點.

## Skipped-item handling

Claude only renders a section if the transcript contains **actual content** matching that agenda item. If a standard 例會 item is missing:

- If **optional** (領先人物, 新會員宣誓, 來賓自我介紹) → just omit the section quietly
- If **mandatory** (核心價值, 60 秒簡報, 業務引薦) → render the header with `> [!warning] 本週略過此議程項目` callout

This way the report honestly reflects what happened AND flags procedural gaps the 副主席 should know about.

## 業務引薦 side-effect (CRM feeder)

In addition to the wiki report, Claude writes `raw/inbox/referrals_<date>.jsonl` — one JSON line per extracted referral:

```json
{"date":"2026-04-25","referrer":"<Member01>","referred_to":"<Member02>","referral":"科技新創需要政府補助諮詢","amount_estimate":"TBD","source":"業務引薦"}
```

The next `ingest-claude` pass folds these into each member's 轉介紀錄 section in `wiki/members/<name>.md`, which feeds `roster-sync` → 紅綠燈 tab scoring.

## Inputs

- `raw/meetings/<date>/transcript.jsonl` (speaker-attributed with per-word timestamps, `relative_seconds`)
- `raw/meetings/<date>/speaker_timeline.json` (per-speaker time ranges)
- `raw/roll_calls/<date>.md`
- `wiki/meetings/<date>.md` (for meeting_type, chapter, start/end)
- `wiki/members/*.md` (for cross-linking)

## Output

- `wiki/meeting_reports/<date>.md` — structured report
- `raw/inbox/referrals_<date>.jsonl` — referrals for CRM sync (may be empty if no 業務引薦 happened)
- `wiki/log.md` — one line appended

## Guardrails

- Never invent quotes — only summarize actual transcript content
- Mark uncertain extractions with `??`
- Preserve `test: true` + `excluded_from_scoring` flags from meeting page
- Skip `(unknown)` / bot-itself speakers
- Traditional Chinese output; English names/aliases as-is
- If transcript is empty/missing → `⚠ no transcript — skipping report` and exit cleanly

## Implementation

Script: `./report.sh`. Entry point:

```bash
bash report.sh <YYYY-MM-DD>
```

## Phase lines per SOUL

```
▸ meeting-report <date> · type=<例會|封閉會議|...>…
✓ wiki/meeting_reports/<date>.md · <N> speakers · <M> referrals extracted
```
