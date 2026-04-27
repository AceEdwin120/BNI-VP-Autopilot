#!/usr/bin/env bash
# meeting-report — produce wiki/meeting_reports/<date>.md with BNI-agenda structure.
#
# Usage: bash report.sh <YYYY-MM-DD>

set -euo pipefail

VAULT="<vault-path>"
DATE="${1:-$(date +%F)}"

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI not found" >&2
  exit 2
fi

TRANSCRIPT="$VAULT/raw/meetings/$DATE/transcript.jsonl"
if [[ ! -s "$TRANSCRIPT" ]]; then
  echo "⚠ no transcript at $TRANSCRIPT — skipping report"
  exit 0
fi

cd "$VAULT"
mkdir -p "$VAULT/wiki/meeting_reports" "$VAULT/raw/inbox"

echo "▸ meeting-report $DATE…"

PROMPT="You are generating a structured BNI meeting report for BNI-Masta's vault.

# Inputs (all relative to $VAULT)

READ in this order:
  1. wiki/meetings/$DATE.md                  → determines meeting_type (決定 template)
  2. wiki/rules/會議議程.md                   → BNI 20-item 例會 agenda reference
  3. wiki/rules/封閉會議.md                   → 4 sub-types of 封閉會議
  4. raw/meetings/$DATE/transcript.jsonl      → speaker-attributed text with per-word timestamps (relative_seconds from meeting start)
  5. raw/meetings/$DATE/speaker_timeline.json → per-speaker time ranges (optional helper)
  6. raw/roll_calls/$DATE.md                  → resolved attendance (names, status, speech duration)
  7. ls wiki/members/                         → to cross-link speakers to canonical [[members/<name>]] pages

# Template selection

Branch on meeting_type from wiki/meetings/$DATE.md:

## If meeting_type == '例會' → use this section skeleton:

SECTION ORDER (omit any section whose transcript content is empty, UNLESS it's a mandatory item — see skip rules below):

---
## 開場（0:00–0:14）
- 本週核心價值：<quote主席 summary>
- 教育單元主題：<教育協調員 summary, 3-5 min block>
- 領先人物（每月第二次才會宣佈）：<副主席 announces, if present>

## 新會員宣誓 / 續約（0:14–0:16）
- Only render if transcript mentions 入會宣誓 / 續約 — else quietly omit.

## 60 秒簡報（0:16–0:49）
One ### per member who spoke in this 33-min window. For each:
### [[members/<姓名>]]（<alias> · <expertise>）
- **本週主軸**: …
- **客戶痛點 / 目標市場**: …
- **引薦指令**: '我要找…' (verbatim if the member stated it clearly)

## 來賓自我介紹（0:49–0:51）
- Only render if 來賓 were present and introduced themselves. Otherwise omit.

## 副主席報告 + 會員委員會報告（0:51–0:53）

## 秘書財務宣佈（0:53–0:54）

## 主題簡報（0:54–1:04）
- **講者**: [[members/<姓名>]]
- **主題**: …
- **目標市場**: …
- **明確引薦指令**: …
- **關鍵內容**: 3-5 bullets

## 業務引薦 · 見證 · 嘉賓心得（1:04–1:22）
Table (ONE row per business referral):
| 時間 | 引薦人 | 被引薦人 | 引薦內容 | 預期金額 |
|---|---|---|---|---|
| mm:ss | [[members/A]] | [[members/B]] | brief description | TBD/NT\$X |

Then (separate subsections if present):
### 見證分享
### 嘉賓心得

## 查核業務引薦（1:22–1:24）
副主席 reviews 2 referrals from prior 2 weeks — record the 2 referrals checked + status.

## 秘書財務報告（1:24–1:26）

## 公告 · 抽獎 · 閉幕（1:26–1:30）
- 公告事項: bullets
- 抽獎得主 (if any)
- 下週主題簡報講者 (if announced)
---

## If meeting_type == '封閉會議' →

First identify sub-type from content: 接待組 / 導師團 / 會員委員會 / 領導團隊月會 (per wiki/rules/封閉會議.md). Set front-matter field: closed_meeting_type: <sub-type>.

Then use sub-type skeleton (from wiki/rules/封閉會議.md):

### 接待組會議 →
  ## 來賓跟進狀況
  ## 來賓數量與質量
  ## 轉換率改善

### 導師團會議 →
  ## 會員輔導紀錄檢視
  ## 紅綠燈檢視結果
  ## 導師協調員總結重點

### 會員委員會會議 →
  ## PALMS 出缺席檢視
  ## 業務引薦狀況
  ## 分會成長與留員
  ## 當責信 / 觀察期 / 開放專業別
  ## 續約與需要輔導的會員
  ## 分會活動與事件
  ## 需要新增的專業別

### 領導團隊月會 →
  ## 主席分會目標與計畫
  ## 副主席（會員委員會總結）
  ## 秘書財務（續約/財務/主題簡報排程）
  ## 接待組長總結
  ## 導師協調員總結
  ## 分會紅綠燈與行動計畫
  ## 會員紅綠燈狀況
  ## 分會主要活動

## If meeting_type is anything else (測試 / 專員會議 / 輔導會議 / unknown) →

Fall back to flat structure:
  ## 會議摘要
  ## 🔑 關鍵決議
  ## 🎯 行動項目
  ## 各位發言重點 (### per speaker)

# Skip rules (applies to 例會)

- **Optional items** (領先人物, 新會員宣誓, 來賓自我介紹, 查核業務引薦, 抽獎): if transcript has no content for them → **quietly omit the whole section**.
- **Mandatory items** (開場核心價值, 60 秒簡報, 副主席報告, 主題簡報, 業務引薦, 公告閉幕): if the window is empty or sparse → render the section header + a '> [!warning] 本週略過此議程項目（或無有效逐字稿）' callout. Do NOT invent content.

Use transcript word-level \`relative_seconds\` (from start of recording) to place content into the right window. The windows in the skeleton above are HINTS — speakers drift. If 60-秒簡報 overruns into 0:52, still group it under '60 秒簡報'.

# Side-effect: 業務引薦 extraction (CRM feeder)

For 例會 AND 封閉會議 reports, also CREATE OR OVERWRITE raw/inbox/referrals_$DATE.jsonl — one JSON object per line, one line per referral you extracted:

{\"date\":\"$DATE\",\"referrer\":\"<Chinese name>\",\"referred_to\":\"<Chinese name OR 'OUTSIDE' if to non-member>\",\"referral\":\"<brief>\",\"amount_estimate\":\"<TBD|NT\$X|USD X>\",\"source\":\"業務引薦\"}

If no 業務引薦 detected → write an empty file (touch it).

# Front-matter shape

---
type: meeting_report
date: $DATE
chapter: (from wiki/meetings/$DATE.md)
meeting_type: (from wiki/meetings/$DATE.md)
closed_meeting_type: (if meeting_type == 封閉會議, one of: 接待組 | 導師團 | 會員委員會 | 領導團隊月會)
duration_min: (compute from meeting_start/meeting_end if available)
speaker_count: (distinct speakers who spoke > 0 seconds, excluding '(unknown)' + bot)
referral_count: (count of rows in 業務引薦 table)
skipped_agenda_items: (list any mandatory items that got the skip-callout)
test: (true if wiki/meetings/$DATE.md has test: true, else omit)
excluded_from_scoring: (same)
source:
  - raw/meetings/$DATE/transcript.jsonl
  - raw/meetings/$DATE/speaker_timeline.json
  - raw/roll_calls/$DATE.md
---

# Guardrails (absolute)

- NEVER invent quotes or content. Only summarize actual transcript text.
- For a speaker's '引薦指令' or '本週主軸', use near-verbatim summary if they stated it clearly; otherwise mark '??'.
- If a speaker's name doesn't match any wiki/members/*.md, use the display name bare + add a \`> [!warning] 無法對應會員：<name>\` callout once under '各位發言重點' (or inline for 例會).
- Skip (unknown) and the Vexa bot itself.
- Preserve Traditional Chinese (don't translate).
- Mark sparse transcript extractions with '??'.

# Output files

1. wiki/meeting_reports/$DATE.md — the full report (OVERWRITE if exists)
2. raw/inbox/referrals_$DATE.jsonl — referral rows (OVERWRITE if exists; touch empty if none)
3. wiki/log.md — append ONE line:
   '$(date '+%Y-%m-%d %H:%M') | meeting-report $DATE | wiki/meeting_reports/$DATE.md (type=<meeting_type>, <N> speakers, <M> referrals, skipped: <list>) | (notes)'

Respond at the end with a one-line summary:
'done · type=<type> · <N> speakers · <M> referrals'"

claude --print --permission-mode acceptEdits "$PROMPT"
