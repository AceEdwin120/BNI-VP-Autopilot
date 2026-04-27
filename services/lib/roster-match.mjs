// roster-match — fuzzy match a Zoom display name against wiki/members/ roster.
// Returns { member, how, score } where `how` is exact_name | exact_alias | fuzzy | bni_format | null.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const MEMBERS_DIR = join(VAULT, "wiki/members");
const FUZZY_THRESHOLD = 78;

// BNI convention (canonical): 01｜張大明｜商業保險  (full-width vertical bar)
// Accepts ANY combination of separators and free-form prefixes — Friday meeting
// 2026-04-24 showed members use wildly different formats:
//   "001<YourChapter> 主席/<MemberName> <EnglishAlias>/AI落地師"
//   "024/<YourChapter><MemberName>/<MemberExpertise>"
//   "012/<MemberName><EnglishAlias>/<MemberExpertise>"
//   "002<YourChapter>副主席<EnglishAlias> <YourName> aiagent"  (no separators)
//   "035<YourChapter>|<MemberName> <EnglishAlias>|<MemberExpertise>"
// We now use this regex JUST to extract the number → name guess; the actual
// "is this a recognized BNI format?" decision is delegated to looksLikeBniFormat
// (declared below) which is far more lenient and uses the matched member.
export const BNI_NAME_FORMAT = /^(\d{1,3})[｜|／/\-\s]+([\u4e00-\u9fff]{2,}|[A-Za-z ]+)[｜|／/\-\s]+(.+)$/;

// Lenient post-match check — given a display name AND the member it matched,
// decide if the user already followed "some" recognizable BNI naming convention.
// Returns true if the display has BOTH a number AND the member's name (or alias).
// That's enough to skip the rename nudge — we don't insist on a specific separator.
export function looksLikeBniFormat(displayName, matchedMember) {
  if (!matchedMember) return false;
  const s = String(displayName || "").trim();
  if (!s) return false;
  const hasNumber = /\d/.test(s);
  const memberName = String(matchedMember.name || "");
  const aliases = Array.isArray(matchedMember.aliases) ? matchedMember.aliases : [];
  const hasName = (memberName && s.includes(memberName)) ||
                  aliases.some(a => a && a.length >= 2 && s.toLowerCase().includes(String(a).toLowerCase()));
  return hasNumber && hasName;
}

// Helper detection — non-chapter members visiting to assist (no PALMS row,
// counted in summary as "Helper"). Convention: display starts with "helper"
// keyword (case-insensitive) followed by a separator. Examples:
//   "helper/<HelperName>/包租代管平台"
//   "Helper - <HelperName>"
export function isHelperName(displayName) {
  return /^\s*(helper|協助|幫忙)[\s\|｜\/／\-:：]+/i.test(String(displayName || ""));
}

// ---------- YAML front-matter parser ----------
function parseFM(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const raw of m[1].split("\n")) {
    const mm = raw.match(/^([a-z_]+):\s*(.*)$/i);
    if (!mm) continue;
    let [, k, v] = mm;
    v = v.trim();
    if (/^\[.*\]$/.test(v)) {
      fm[k] = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      fm[k] = v.replace(/^["']|["']$/g, "");
    }
  }
  return fm;
}

// ---------- fuzzy ----------
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1), v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const c = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + c);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}
function ratio(a, b) {
  if (!a || !b) return 0;
  return Math.round((1 - lev(a, b) / Math.max(a.length, b.length)) * 100);
}

// ---------- roster load (cached) ----------
let _rosterCache = null, _rosterLoadedAt = 0;
export function loadRoster() {
  const now = Date.now();
  if (_rosterCache && (now - _rosterLoadedAt) < 30000) return _rosterCache;
  if (!existsSync(MEMBERS_DIR)) { _rosterCache = []; return []; }
  const out = [];
  for (const f of readdirSync(MEMBERS_DIR)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const fm = parseFM(readFileSync(join(MEMBERS_DIR, f), "utf8"));
    if (fm.type !== "member") continue;
    out.push({
      id: f.replace(/\.md$/, ""),
      name: fm.name || f.replace(/\.md$/, ""),
      aliases: Array.isArray(fm.aliases) ? fm.aliases : [],
      expertise: fm.expertise || "",
      chapter: fm.chapter || "",
      status: fm.status || "active",
    });
  }
  _rosterCache = out;
  _rosterLoadedAt = now;
  return out;
}

// ---------- BNI format parser ----------
// Returns { number, name, expertise } or null if doesn't match BNI format.
export function parseBniFormat(displayName) {
  const m = displayName.match(BNI_NAME_FORMAT);
  if (!m) return null;
  return { number: m[1], name: m[2].trim(), expertise: m[3].trim() };
}

// Normalize: collapse whitespace, lowercase. Keeps CJK intact.
function norm(s) { return String(s || "").trim().replace(/\s+/g, "").toLowerCase(); }

// Tokenize on whitespace AND on common CJK/Latin boundary (e.g. "<MemberName><EnglishAlias>" → ["<MemberName>", "<EnglishAlias>"])
function tokens(s) {
  const out = [];
  // Split on whitespace first
  for (const w of String(s || "").split(/\s+/).filter(Boolean)) {
    // Split CJK block from Latin block
    const parts = w.match(/[\u4e00-\u9fff]+|[A-Za-z]+|\d+/g) || [w];
    for (const p of parts) out.push(p);
  }
  return out;
}

// Substitute keyword. If the display name contains "代理人" anywhere, the
// person is acting as a 代理人 (substitute) for the rest-of-the-name member.
// Convention members are taught by the in-meeting nudge (see meeting-handlers).
//   "01｜張大明｜商業保險-代理人"  → substitute for 張大明
//   "張大明-代理人"                 → substitute for 張大明 (short form)
const SUBSTITUTE_KW = "代理人";
// Strip the keyword and any surrounding whitespace / dashes (ASCII + 全形)
function stripSubstituteKw(s) {
  return String(s || "").replace(/[\s\-－—–]*代理人[\s\-－—–]*/g, "").trim();
}

// ---------- main matcher ----------
// Tolerant: strip BNI format → match on name part; strip whitespace;
// try full string exact, then per-token exact (catches "<MemberName> <EnglishAlias>"),
// then fuzzy against normalized. Detects "-代理人" substitute suffix.
export function matchDisplayName(displayName, roster = null) {
  const rs = roster || loadRoster();
  const raw = String(displayName || "").trim();
  if (!raw) return { member: null, how: null, score: 0, isSubstitute: false };

  const isVisitor = /^來賓[\s|｜]/.test(raw);

  // Detect 代理人 marker BEFORE everything else; strip it for the rest of
  // the matching. The cleaned name is what we match against the roster.
  const isSubstitute = raw.includes(SUBSTITUTE_KW);
  const cleaned = isSubstitute ? stripSubstituteKw(raw) : raw;

  // If BNI format, extract the middle name cell (using the cleaned string)
  const bni = parseBniFormat(cleaned);
  const candidateFull = bni ? bni.name : cleaned;
  const candidateNorm = norm(candidateFull);
  const candidateTokens = tokens(candidateFull);

  // Build roster lookup — all (member, variant, normalized) tuples
  const variants = [];
  for (const m of rs) {
    variants.push({ m, v: m.name, nv: norm(m.name) });
    for (const a of m.aliases) variants.push({ m, v: a, nv: norm(a) });
  }

  const isHelper = isHelperName(raw);

  // Helper builder: standardizes the return shape AND uses the lenient
  // looksLikeBniFormat() check (instead of just the strict regex match) so
  // we don't nudge members who already used a recognizable format like
  // "001<YourChapter> 主席/<MemberName> <EnglishAlias>/AI落地師" (no full-width pipes).
  const make = (member, how, score) => ({
    member,
    how,
    score,
    bniFormat: looksLikeBniFormat(raw, member),
    isVisitor,
    isSubstitute,
    isHelper,
  });

  // 1. Exact match on full normalized candidate
  for (const { m, v, nv } of variants) {
    if (nv && nv === candidateNorm) {
      return make(m, v === m.name ? "exact_name" : "exact_alias", 100);
    }
  }
  // 2. Exact match on ANY token of candidate (handles "<MemberName> <EnglishAlias>", "<EnglishAlias> <ChineseName>")
  for (const tok of candidateTokens) {
    const tn = norm(tok);
    if (tn.length < 2) continue;
    for (const { m, v, nv } of variants) {
      if (nv && nv === tn) {
        return make(m, v === m.name ? "exact_name_token" : "exact_alias_token", 100);
      }
    }
  }
  // 3. Fuzzy against full normalized
  let best = { member: null, how: null, score: 0 };
  for (const { m, nv } of variants) {
    const s = ratio(candidateNorm, nv);
    if (s > best.score) best = { member: m, how: "fuzzy", score: s };
  }
  if (best.score >= FUZZY_THRESHOLD) return make(best.member, best.how, best.score);

  // 4. No match
  return make(null, null, best.score);
}
