#!/usr/bin/env node
// resolve-attendance — match Vexa participants → roster, classify, write roll_call
//
// Usage: node resolve.mjs <YYYY-MM-DD>

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const MEMBERS_DIR = join(VAULT, "wiki/members");
const GRACE_LATE_MIN = Number(process.env.GRACE_LATE_MIN || 15);
const GRACE_EARLY_MIN = Number(process.env.GRACE_EARLY_MIN || 10);
const FUZZY_THRESHOLD = 85;

// ------- tiny fuzzy (token-sort ratio via Levenshtein) -------
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1);
  const v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}
function ratio(a, b) {
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return Math.round((1 - d / Math.max(a.length, b.length)) * 100);
}
function tokenSort(s) {
  return String(s).toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");
}
function tokenSortRatio(a, b) {
  return ratio(tokenSort(a), tokenSort(b));
}

// ------- roster loading -------
function loadRoster() {
  if (!existsSync(MEMBERS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(MEMBERS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(MEMBERS_DIR, f), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = {};
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^([a-z_]+):\s*(.*)$/);
      if (mm) fm[mm[1]] = mm[2].trim();
    }
    const name = fm.name || f.replace(/\.md$/, "");
    let aliases = [];
    if (fm.aliases?.startsWith("[") && fm.aliases.endsWith("]")) {
      aliases = fm.aliases
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    out.push({
      id: f.replace(/\.md$/, ""),
      name,
      aliases,
      chapter: fm.chapter || "",
      index: fm.index || "",
      expertise: fm.expertise || "",
    });
  }
  return out;
}

// ------- match tiers -------
function matchExact(display, roster) {
  const d = display.toLowerCase().trim();
  for (const m of roster) {
    if (m.name.toLowerCase() === d) return { member: m, how: "name" };
    for (const a of m.aliases) if (a.toLowerCase() === d) return { member: m, how: "alias" };
  }
  return null;
}
function matchFuzzy(display, roster) {
  let best = { score: 0, member: null, how: "" };
  for (const m of roster) {
    for (const cand of [m.name, ...m.aliases]) {
      const s = tokenSortRatio(display, cand);
      if (s > best.score) best = { score: s, member: m, how: `fuzzy(${cand}, ${s})` };
    }
  }
  return best.score >= FUZZY_THRESHOLD ? best : null;
}
// 編號 (BNI member number) prefix match — strongest signal, deterministic.
// Display-name convention is "<編號>/<name>/<expertise>", e.g. "026/Jessica/餐飲".
// We accept 1-3 leading digits ONLY IF the next char is whitespace, a separator,
// or a Chinese character — this prevents false positives like "10vouchers".
// The numeric value (zero-padded to 3 digits) must match an existing member's
// `index` YAML field.
//
// Consistency check: 編號 alone is NOT sufficient — members occasionally type
// the wrong number (e.g. 傅菽駗 wrote "009/傅菽駗/..." but his real index is 030).
// Require a secondary signal: either the member's Chinese name appears in the
// display, OR the display shares ≥3 distinct chars with the member's expertise.
function charOverlap(a, b) {
  // Count distinct meaningful chars (Chinese + English letters only — skip
  // digits, punctuation, whitespace) that appear in both strings.
  const re = /[\u4e00-\u9fffa-zA-Z]/g;
  const setA = new Set();
  const setB = new Set();
  for (const m of String(a).toLowerCase().matchAll(re)) setA.add(m[0]);
  for (const m of String(b).toLowerCase().matchAll(re)) setB.add(m[0]);
  let n = 0;
  for (const c of setA) if (setB.has(c)) n++;
  return n;
}
// Chinese-name typo match — handles visually similar single-char typos
// (傅 vs 傳, 莞 vs 婉, 軒 vs 軒) that fuzzy ratio can't catch on 3-char names.
// Slides a window of the member's name length across the display, accepts the
// match if Levenshtein distance is exactly 1 AND the display also overlaps the
// member's expertise by ≥2 chars (prevents random text from matching a common
// name like 林孟葦).
function matchChineseTypo(display, roster) {
  const s = String(display);
  for (const m of roster) {
    const name = m.name || "";
    const len = name.length;
    if (len < 3 || len > 4) continue;  // Only 3-4 char Chinese names
    if (!/^[\u4e00-\u9fff]+$/.test(name)) continue;  // Must be all Chinese
    for (let i = 0; i <= s.length - len; i++) {
      const sub = s.slice(i, i + len);
      if (!/^[\u4e00-\u9fff]+$/.test(sub)) continue;
      if (levenshtein(sub, name) === 1) {
        const expOverlap = charOverlap(m.expertise || "", s);
        if (expOverlap >= 2) {
          return { member: m, how: `typo(${name}~${sub},${expOverlap}ch)` };
        }
      }
    }
  }
  return null;
}

function matchByIndex(display, roster) {
  const s = String(display).trim();
  const m = s.match(/^(\d{1,3})(?:[\s\/\-\|｜：:．\.,，、]|[\u4e00-\u9fff])/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!num || num < 1 || num > 999) return null;
  const target = String(num).padStart(3, "0");
  const member = roster.find(r => String(r.index || "").padStart(3, "0") === target);
  if (!member) return null;
  const displayLower = s.toLowerCase();
  // (a) Display contains member's Chinese name → confirmed
  if (member.name && displayLower.includes(member.name.toLowerCase())) {
    return { member, how: `index+name(${target})` };
  }
  // (b) Display shares ≥3 distinct chars with member's expertise → confirmed
  const expOverlap = charOverlap(member.expertise || "", s);
  if (expOverlap >= 3) {
    return { member, how: `index+expertise(${target},${expOverlap}ch)` };
  }
  // 編號 alone with no secondary signal → fall through to fuzzy/LLM
  return null;
}
function matchLLM(display, roster) {
  if (!hasClaude()) return null;
  // Include `index` + `expertise` so Claude can reason about 編號 prefixes and
  // expertise-domain overlap (the resolver previously dropped both, which is why
  // English-named members like "026/Jessica/餐飲Ai" got classified as visitors
  // even though their 編號 + expertise unambiguously matched a real member).
  const rosterMini = roster.map((m) => ({
    id: m.id,
    index: String(m.index || "").padStart(3, "0"),
    name: m.name,
    aliases: m.aliases,
    expertise: m.expertise || "",
  }));
  const prompt = `You are matching a Zoom participant display name to a BNI <YourChapter>分會 member.

Roster (JSON, ${rosterMini.length} members):
${JSON.stringify(rosterMini)}

Display name: "${display}"

Match by priority (use the FIRST that fits, never invent):
1. **編號 prefix** — display often starts with the member's "index" (e.g. "026/Jessica/餐飲Ai轉型顧問" → member with index "026").
2. **Chinese full name** — display contains member's "name" verbatim (with or without separators).
3. **Alias** — display contains an item from the member's "aliases" (English nicknames, partial names).
4. **Near-name match (typo)** — display contains a Chinese name that differs from a member's "name" by exactly 1 character at the same position (e.g. display "傅菽駗" vs roster "傳菽駗" — 傅/傳 are commonly confused) AND the display's expertise matches that member's "expertise". Match the roster member, not the typo.
5. **Expertise + non-roster name combo** — display contains a non-roster Chinese name (e.g. "Max" or "張小華") AND its profession description shares ≥3 distinctive characters with exactly one member's "expertise". This catches members using nicknames (e.g. display "Max/企業流程自動化" → member <MemberA>, expertise "企業流程自動化建置").

**HARD REJECTIONS** (return NONE even if expertise overlaps):
- Display contains any of: "董顧", "區董", "顧問師", "helper", "Helper", "助理", "助手", "來賓", "訪客", "guest", "Guest" — these are external visitors / cross-chapter consultants, NEVER members.
- Display is just an English first name with no profession context (e.g. "Mike" alone).
- Multiple members share the same expertise domain (ambiguous).

Return ONLY the matched member's "id" string, or the literal word NONE if no member fits with confidence.`;
  const r = spawnSync("claude", ["--print", prompt], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  const ans = (r.stdout || "").trim();
  if (!ans || /^NONE$/i.test(ans)) return null;
  const m = roster.find((x) => x.id === ans);
  return m ? { member: m, how: "llm" } : null;
}
function hasClaude() {
  try {
    execFileSync("which", ["claude"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ------- 遲到 cutoff -------
// BNI hard rule: Friday morning 例會 — members must be IN by 07:05 Taipei.
// Other days use the flexible (meeting_start + GRACE_LATE_MIN) rule.
const FRIDAY_LATE_CUTOFF_LOCAL = process.env.BNI_LATE_CUTOFF || "07:05"; // Taipei wall-clock
function isFridayDate(dateStr) {
  // dateStr = YYYY-MM-DD (Taipei wall-clock); use noon to avoid TZ rollover.
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  return d.getUTCDay() === 5; // 0=Sun, 5=Fri
}
function lateCutoffMs(dateStr, startMs) {
  if (isFridayDate(dateStr)) {
    // Friday: hard 07:05 Taipei wall-clock.
    return new Date(`${dateStr}T${FRIDAY_LATE_CUTOFF_LOCAL}:00+08:00`).getTime();
  }
  // Other days: flexible — meeting_start + grace.
  return startMs + GRACE_LATE_MIN * 60000;
}

// ------- classification -------
// Returns one of: 全程, 遲到, 早退, 遲到+早退, 缺席.
// "On time" = arrived BEFORE the late cutoff (07:05 Taipei for Friday meetings,
// or meeting_start + GRACE_LATE_MIN otherwise). Bug fix 2026-04-24: previously
// used `firstJoin <= startMs` which marked anyone joining 1 second after the
// bot started recording as 遲到 even if they were 20 minutes early relative
// to the BNI 07:05 cutoff. Now uses lateCut consistently.
function classify(p, start, end, dateStr) {
  const firstJoin = new Date(p.firstJoin);
  const lastLeave = p.lastLeave ? new Date(p.lastLeave) : null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const lateCut = lateCutoffMs(dateStr, startMs);
  const earlyCut = endMs - GRACE_EARLY_MIN * 60000;
  if (!p.firstJoin) return "缺席";
  const onTime = firstJoin.getTime() <= lateCut;
  const leftEarly = lastLeave && lastLeave.getTime() < earlyCut;
  if (!onTime && firstJoin.getTime() > endMs) return "缺席";
  if (onTime && !leftEarly) return "全程";
  if (onTime && leftEarly) return "早退";
  if (!onTime && !leftEarly) return "遲到";
  return "遲到+早退"; // !onTime && leftEarly
}

// ------- substitute detection (mirrors roster-match.mjs convention) -------
function isSubstituteName(display) {
  return String(display || "").includes("代理人");
}
function stripSubstituteKw(display) {
  return String(display || "").replace(/[\s\-－—–]*代理人[\s\-－—–]*/g, "").trim();
}

// ------- helper detection (mirrors roster-match.mjs::isHelperName) -------
// Convention: display starts with "helper/" (case-insensitive). Helper is
// a non-chapter member visiting to assist — counted in summary, no PALMS row.
function isHelperName(display) {
  return /^\s*(helper|協助|幫忙)[\s\|｜\/／\-:：]+/i.test(String(display || ""));
}
function stripHelperPrefix(display) {
  return String(display || "").replace(/^\s*(helper|協助|幫忙)[\s\|｜\/／\-:：]+/i, "").trim();
}

// ------- aggregation -------
function aggregateEvents(events) {
  const byKey = new Map();
  for (const e of events) {
    const key = e.participant_id || e.display_name;
    if (!byKey.has(key)) {
      byKey.set(key, { key, displayNames: [], joins: [], leaves: [], speechSec: 0 });
    }
    const p = byKey.get(key);
    if (e.type === "participant_join") p.joins.push(e.timestamp);
    else if (e.type === "participant_leave") p.leaves.push(e.timestamp);
    else if (e.type === "rename") p.displayNames.push({ t: e.timestamp, name: e.new_name });
    else if (e.type === "speech" && e.duration_sec) p.speechSec += e.duration_sec;
    if (e.display_name) p.displayNames.push({ t: e.timestamp, name: e.display_name });
  }
  for (const p of byKey.values()) {
    p.joins.sort();
    p.leaves.sort();
    p.firstJoin = p.joins[0] || null;
    p.lastLeave = p.leaves[p.leaves.length - 1] || null;
    p.displayNames.sort((a, b) => (a.t < b.t ? -1 : 1));
    p.currentName = p.displayNames[p.displayNames.length - 1]?.name || "(unknown)";
  }
  return [...byKey.values()];
}

// ------- main -------
function main() {
  const [, , dateArg] = process.argv;
  if (!dateArg) {
    console.error("usage: resolve.mjs <YYYY-MM-DD>");
    process.exit(2);
  }
  const meetingDir = join(VAULT, "raw/meetings", dateArg);
  const eventsFile = join(meetingDir, "participants.jsonl");
  if (!existsSync(eventsFile)) {
    console.error(`not found: ${eventsFile}`);
    process.exit(2);
  }
  let events = readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // Phantom filter: if participants_list.json exists (Recall's authoritative
  // list of real humans), drop events whose participant_id isn't in it AND whose
  // display name is empty (= likely the bot's own shadow event).
  const listPath = join(meetingDir, "participants_list.json");
  if (existsSync(listPath)) {
    try {
      const list = JSON.parse(readFileSync(listPath, "utf8"));
      const validIds = new Set(list.map(p => String(p.id)));
      const before = events.length;
      events = events.filter(e => {
        // Drop only phantom events: missing participant_id AND no display name
        if (!e.participant_id && !e.display_name) return false;
        // Drop if we have a participant_id that's NOT in the authoritative list AND the name is missing
        if (e.participant_id && !validIds.has(String(e.participant_id)) && !e.display_name) return false;
        return true;
      });
      if (events.length < before) {
        console.log(`[phantom-filter] dropped ${before - events.length} of ${before} events`);
      }
    } catch (e) {
      console.log(`[phantom-filter] couldn't parse participants_list.json: ${e.message}`);
    }
  }

  let start, end;
  const botFiles = readdirSync(meetingDir).filter((f) => f.endsWith(".bot.json"));
  if (botFiles.length) {
    const manifest = JSON.parse(readFileSync(join(meetingDir, botFiles[0]), "utf8"));
    start = manifest.scheduled_start || manifest.created_at;
    end = manifest.done_at || manifest.ended_at;
  }
  start = start || events.find((e) => e.type === "participant_join")?.timestamp;
  end = end || events.slice().reverse().find((e) => e.type === "participant_leave")?.timestamp;

  const roster = loadRoster();
  const parts = aggregateEvents(events);
  const rows = [];
  const visitorLines = [];
  const substitutes = [];        // [{member, by}] for the digest + audit
  const helpers = [];            // [name] — non-chapter members who came to assist
  const presentMemberIds = new Set();  // Track which members have been counted
  const visitorSeen = new Set();       // Dedup visitors by display-name
  const helperSeen = new Set();        // Dedup helpers by display-name

  for (const p of parts) {
    const display = p.currentName;
    // Helper convention: display starts with "helper/..." → not a member,
    // not a regular visitor; counted separately, no PALMS row.
    if (isHelperName(display)) {
      const cleaned = stripHelperPrefix(display);
      const dedupKey = cleaned.toLowerCase().replace(/\s+/g, "");
      if (!helperSeen.has(dedupKey)) {
        helperSeen.add(dedupKey);
        helpers.push(cleaned);
        rows.push({
          member: "—",
          status: "Helper",
          display,
          join: p.firstJoin || "—",
          leave: p.lastLeave || "—",
          speech: p.speechSec,
          how: "helper",
        });
      }
      continue;
    }
    // Detect 代理人 BEFORE matching — strip the keyword so the cleaned name
    // hits the roster (the substitute identifies as the member they're for).
    const isSub = isSubstituteName(display);
    const matchInput = isSub ? stripSubstituteKw(display) : display;
    const match = matchExact(matchInput, roster) || matchByIndex(matchInput, roster) || matchChineseTypo(matchInput, roster) || matchFuzzy(matchInput, roster) || matchLLM(matchInput, roster);
    let status = classify(p, start, end, dateArg);
    // Substitute override: if matched AND keyword present, the row is 代理人.
    if (match && isSub) {
      status = "代理人";
      substitutes.push({ member: match.member.name, by: display });
    }
    if (match) {
      presentMemberIds.add(match.member.id);
      rows.push({
        member: `[[members/${match.member.id}]]`,
        status,
        display,
        join: p.firstJoin || "—",
        leave: p.lastLeave || "—",
        speech: p.speechSec,
        how: isSub ? `${match.how}+代理人` : match.how,
      });
    } else {
      // Visitor — dedup by normalized display so the same person joining twice
      // (left+rejoined) doesn't double-count.
      const dedupKey = String(display).toLowerCase().replace(/\s+/g, "");
      if (visitorSeen.has(dedupKey)) continue;
      visitorSeen.add(dedupKey);
      rows.push({
        member: "—",
        status: "來賓",
        display,
        join: p.firstJoin || "—",
        leave: p.lastLeave || "—",
        speech: p.speechSec,
        how: "unmatched",
      });
      visitorLines.push(
        JSON.stringify({ date: dateArg, display, firstJoin: p.firstJoin, lastLeave: p.lastLeave, speechSec: p.speechSec }),
      );
    }
  }

  // Roll-up counts for digest consumption (in front-matter so digest can read
  // them without re-classifying).
  // CRITICAL: counts are by UNIQUE MEMBER ID, not row count. Same member with
  // multiple participant_ids (e.g. joined from 2 devices) creates 2 rows but
  // is one person. We pick the BEST status per member (全程 beats 遲到 beats
  // 早退 etc.) since they were genuinely present.
  const STATUS_PRESENT = new Set(["全程", "遲到", "早退", "遲到+早退", "代理人"]);
  const memberRows = rows.filter(r => r.member !== "—");
  const visitorRows = rows.filter(r => r.member === "—" && r.status === "來賓");
  // Map memberId → best status across all rows for that member
  const STATUS_RANK = { "全程": 5, "代理人": 4, "遲到": 3, "早退": 2, "遲到+早退": 1, "缺席": 0 };
  const memberStatus = new Map(); // memberId → best status string
  for (const r of memberRows) {
    const mid = r.member.match(/\[\[members\/([^\]]+)\]\]/)?.[1];
    if (!mid) continue;
    const cur = memberStatus.get(mid);
    if (!cur || (STATUS_RANK[r.status] ?? -1) > (STATUS_RANK[cur] ?? -1)) {
      memberStatus.set(mid, r.status);
    }
  }
  const cntStatus = (...accept) => [...memberStatus.values()].filter(s => accept.includes(s)).length;
  const presentCount = [...memberStatus.values()].filter(s => STATUS_PRESENT.has(s)).length;
  const presentFull = cntStatus("全程");
  const lateCount = cntStatus("遲到", "遲到+早退");
  const earlyLeaveCount = cntStatus("早退", "遲到+早退");
  const substituteCount = cntStatus("代理人");
  const absentMembers = roster
    .filter(m => (m.status || "active") === "active" && !presentMemberIds.has(m.id))
    .map(m => m.name);
  const absentCount = absentMembers.length;
  const expectedCount = roster.filter(m => (m.status || "active") === "active").length;
  const lateArrivals = memberRows
    .filter(r => r.status === "遲到" || r.status === "遲到+早退")
    .map(r => {
      // Extract member id from "[[members/<id>]]"
      const m = r.member.match(/\[\[members\/([^\]]+)\]\]/);
      const id = m ? m[1] : null;
      const member = roster.find(x => x.id === id);
      return member ? member.name : id;
    })
    .filter(Boolean);
  const visitorNames = visitorRows.map(r => r.display);
  // Helper rows are stored alongside (member="—", status="Helper") — pulled out for the digest.
  const helperRows = rows.filter(r => r.status === "Helper");

  const yamlList = (arr) => arr.length ? `[${arr.map(s => `"${String(s).replace(/"/g, '\\"')}"`).join(", ")}]` : "[]";
  const yamlSubs = substitutes.length
    ? "\n" + substitutes.map(s => `  - member: "${s.member}"\n    by: "${s.by.replace(/"/g, '\\"')}"`).join("\n")
    : " []";

  const outDir = join(VAULT, "raw/roll_calls");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${dateArg}.md`);
  const lateCutoffUsed = isFridayDate(dateArg) ? FRIDAY_LATE_CUTOFF_LOCAL : `start+${GRACE_LATE_MIN}min`;
  const fm = [
    "---",
    "type: roll_call",
    `date: ${dateArg}`,
    `meeting_start: "${start}"`,
    `meeting_end: "${end}"`,
    `late_cutoff: "${lateCutoffUsed}"`,
    `expected_count: ${expectedCount}`,
    `present_count: ${presentCount}`,
    `present_full: ${presentFull}`,
    `late_count: ${lateCount}`,
    `early_leave_count: ${earlyLeaveCount}`,
    `substitute_count: ${substituteCount}`,
    `absent_count: ${absentCount}`,
    `visitor_count: ${visitorNames.length}`,
    `helper_count: ${helpers.length}`,
    `absent_members: ${yamlList(absentMembers)}`,
    `late_arrivals: ${yamlList(lateArrivals)}`,
    `visitors: ${yamlList(visitorNames)}`,
    `helpers: ${yamlList(helpers)}`,
    `substitutes:${yamlSubs}`,
    `source: raw/meetings/${dateArg}/participants.jsonl`,
    `resolved_at: "${new Date().toISOString()}"`,
    "---",
    "",
    "| 會員 | 狀態 | 顯示名稱 | 加入時間 | 離開時間 | 發言秒數 | 匹配來源 |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.member} | ${r.status} | ${r.display} | ${r.join} | ${r.leave} | ${r.speech} | ${r.how} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(outPath, fm);

  if (visitorLines.length) {
    const visDir = join(VAULT, "raw/visitors");
    mkdirSync(visDir, { recursive: true });
    appendFileSync(join(visDir, `${dateArg}.jsonl`), visitorLines.join("\n") + "\n");
  }

  console.log(`✔ wrote ${outPath} — 應到 ${expectedCount} · 實到 ${presentCount} · 代理 ${substituteCount} · 遲到 ${lateCount} · 缺席 ${absentCount} · 來賓 ${visitorNames.length} · Helper ${helpers.length}`);
}

main();
