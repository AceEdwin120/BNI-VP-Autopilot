// qa-cache — instant lookup table for common BNI questions answered from the
// Obsidian vault. Replies in <100ms (no LLM call) for cache hits. Cache miss
// → caller falls through to the LLM responder (claude or openclaw).
//
// Patterns are static; answer-templates pull live data from
// wiki/members/*.md + wiki/rules/*.md. The vault snapshot is rebuilt only
// when ANY wiki/ file mtime advances OR every 5 min, matching the cadence
// of buildVaultContext() in llm-responder.mjs.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
let _snap = { builtAt: 0, latestMtime: 0, members: [], rules: new Map() };

function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return fm;
}

function latestMtime(dirs) {
  let latest = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        try { const s = statSync(join(dir, f)); if (s.mtimeMs > latest) latest = s.mtimeMs; } catch {}
      }
    } catch {}
  }
  return latest;
}

function firstParagraph(text, maxChars = 100) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const para of body.split(/\n\n+/)) {
    const t = para.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^>/.test(t)) continue;
    if (/^\|/.test(t)) continue;
    return t.slice(0, maxChars);
  }
  return "";
}

function rebuildIfStale() {
  const dirs = [join(VAULT, "wiki/members"), join(VAULT, "wiki/rules")];
  const m = latestMtime(dirs);
  const now = Date.now();
  if (_snap.members.length && _snap.latestMtime === m && (now - _snap.builtAt) < CACHE_MAX_AGE_MS) return;

  const memberDir = join(VAULT, "wiki/members");
  const members = [];
  if (existsSync(memberDir)) {
    for (const f of readdirSync(memberDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const fm = parseFrontMatter(readFileSync(join(memberDir, f), "utf8"));
        if (fm.status && fm.status !== "active") continue;
        const aliases = (fm.aliases || "").replace(/[\[\]"']/g, "").split(",").map(s => s.trim()).filter(Boolean);
        members.push({
          name: fm.name || f.replace(/\.md$/, ""),
          expertise: fm.expertise || "",
          aliases,
          file: f,
        });
      } catch {}
    }
  }

  const ruleDir = join(VAULT, "wiki/rules");
  const rules = new Map();
  if (existsSync(ruleDir)) {
    for (const f of readdirSync(ruleDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const text = readFileSync(join(ruleDir, f), "utf8");
        rules.set(f.replace(/\.md$/, ""), firstParagraph(text, 100));
      } catch {}
    }
  }

  _snap = { builtAt: now, latestMtime: m, members, rules };
}

// ---------- pattern handlers (return string OR null on no-match) ----------

function findMember(question) {
  rebuildIfStale();
  // Try to extract a likely-Chinese name (2-4 Chinese chars) or English alias
  // mentioned in the question. Match against canonical name + aliases.
  for (const mem of _snap.members) {
    if (mem.name && question.includes(mem.name)) return mem;
    for (const a of mem.aliases) {
      if (a && a.length >= 2 && new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question)) return mem;
    }
  }
  return null;
}

function nextFridayDate(now = new Date()) {
  // Returns YYYY-MM-DD of the next Friday (or today if today is Friday before 08:00 Taipei)
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
  const wkFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", weekday: "short" });
  const todayKey = fmt.format(now);
  const todayWk = wkFmt.format(now); // "Fri", "Mon", ...
  const wkMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayIdx = wkMap[todayWk];
  let daysUntilFri = (5 - dayIdx + 7) % 7;
  if (daysUntilFri === 0) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", hour12: false }).format(now));
    if (hour >= 8) daysUntilFri = 7; // already past meeting today
  }
  const target = new Date(now.getTime() + daysUntilFri * 24 * 3600 * 1000);
  return fmt.format(target);
}

// Each entry: { name, match(q): bool, answer(q): string }
const PATTERNS = [
  // 1. member count
  {
    name: "member_count",
    match: q => /多少.*會員|幾位.*會員|會員.*多少|會員.*幾位|how many.*member|member.*count/i.test(q),
    answer: () => { rebuildIfStale(); return `<YourChapter>目前 ${_snap.members.length} 位 active 會員 🦁`; },
  },
  // 2. <member>.expertise — "X 的專業" / "X 是做什麼" / "X 專業"
  {
    name: "member_expertise",
    match: q => /專業|做什麼|是做|expertise|profession/i.test(q) && !!findMember(q),
    answer: q => {
      const m = findMember(q);
      if (!m) return null;
      return m.expertise ? `${m.name} 的專業：${m.expertise} ✨` : `${m.name} 是 active 會員，但 wiki 沒填寫專業欄位`;
    },
  },
  // 3. is X a member? — "X 在不在分會" / "X 是會員嗎"
  {
    name: "member_exists",
    match: q => /在分會|是會員|是.*active|member.*\?/i.test(q) && !!findMember(q),
    answer: q => { const m = findMember(q); return m ? `✓ ${m.name} 是<YourChapter> active 會員` : null; },
  },
  // 4. who is the 副主席?
  {
    name: "vice_chair",
    match: q => /副主席.*(誰|是)|(誰|who).*副主席|vice.*chair/i.test(q),
    answer: () => "副主席是 <YourName> 🦁（你正在跟他的 AI 助理說話）",
  },
  // 5. who is the 主席?
  {
    name: "chair",
    match: q => /主席.*(誰|是)|(誰|who).*主席|^chair/i.test(q) && !/副主席/.test(q),
    answer: () => "主席：（wiki 尚未填寫此欄位 📝）",
  },
  // 6. chapter name
  {
    name: "chapter_name",
    match: q => /分會.*(名|叫)|分會.*在哪|chapter.*name|哪.*分會/i.test(q),
    answer: () => "<YourChapter> — 台北 BNI 分會之一",
  },
  // 7. next meeting
  {
    name: "next_meeting",
    match: q => /下次.*會議|下.*例會|next meeting|when.*meeting/i.test(q),
    answer: () => `下次例會：${nextFridayDate()}（週五）06:45–08:00 台灣時間 ⏰`,
  },
  // 8. meeting time / when do we meet
  {
    name: "meeting_time",
    match: q => /會議時間|什麼時候開會|幾點開會|when.*we.*meet/i.test(q),
    answer: () => "每週五 06:45–08:00（台灣時間）⏰",
  },
  // 9. <rule>.first_paragraph — match by rule filename or alias
  {
    name: "rule_lookup",
    match: q => {
      rebuildIfStale();
      for (const k of _snap.rules.keys()) if (q.includes(k)) return true;
      return false;
    },
    answer: q => {
      rebuildIfStale();
      for (const [k, gist] of _snap.rules) {
        if (q.includes(k)) return `📖 ${k}：${gist}（完整內容請見 wiki/rules/${k}.md）`;
      }
      return null;
    },
  },
  // 10. BNI 7 core values
  {
    name: "core_values",
    match: q => /核心價值.*(有哪些|是什麼|哪些)|core.*value/i.test(q),
    answer: () => "BNI 7 核心價值：付出者收穫 · 建立關係 · 終身學習 · 傳統與創新 · 正面積極的態度 · 當責 · 認可與表揚 ✨",
  },
  // 11. 付出者收穫 meaning
  {
    name: "givers_gain",
    match: q => /付出者收穫.*(意思|是什麼)|givers.*gain.*mean/i.test(q),
    answer: () => "付出者收穫（Givers Gain）— 在期待回報前，先願意主動付出。BNI 最核心的價值觀。",
  },
];

// Public API: returns { reply, pattern, elapsedMs } on hit, or null on miss.
export function tryCachedAnswer(question) {
  if (!question || typeof question !== "string") return null;
  const t0 = Date.now();
  const q = question.trim();
  for (const p of PATTERNS) {
    try {
      if (!p.match(q)) continue;
      const a = p.answer(q);
      if (!a) continue;
      const elapsedMs = Date.now() - t0;
      return { reply: a.slice(0, 240), pattern: p.name, elapsedMs };
    } catch {} // pattern errors should never block fallthrough
  }
  return null;
}

// Exported for diagnostics / tests
export function _snapshot() { rebuildIfStale(); return _snap; }
export function _patterns() { return PATTERNS.map(p => p.name); }
