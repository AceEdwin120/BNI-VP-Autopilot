#!/usr/bin/env node
// post-meeting-line-digest — sends the BNI 副主席 standard post-meeting
// attendance summary to the operator's LINE after every Friday 例會.
//
// Usage: node digest.mjs <YYYY-MM-DD> <bot_id> [--force]
//   --force: bypass BOTH the Friday-only gate AND the idempotency marker
//
// Reads:
//   raw/roll_calls/<date>.md          (authoritative — counts + lists in front-matter)
//   wiki/members/*.md                  (for each member's index = BNI 編號)
//   wiki/meetings/<date>.md            (optional — for test/excluded flag)
//
// Writes:
//   raw/meetings/<date>/<bot_id>.line_digest_sent   (idempotency + audit marker)

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
const OPENCLAW_JSON = "~/.openclaw/openclaw.json";
const CHAPTER_NAME = process.env.BNI_CHAPTER_NAME || "<YourChapter>";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

// ---------- secrets / config ----------
function getLineToken() {
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  // Fall back to openclaw.json (channels.line.channelAccessToken)
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
    return cfg.channels?.line?.channelAccessToken || null;
  } catch { return null; }
}
function getAlexLineId() {
  if (process.env.ALEX_LINE_ID) return process.env.ALEX_LINE_ID;
  // Fall back to openclaw.json (channels.line.allowFrom[0]) — confirmed to be the operator's userId
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
    const allow = cfg.channels?.line?.allowFrom || [];
    return allow.find(x => /^U[a-f0-9]{32}$/.test(x)) || "<your-line-user-id>";
  } catch { return "<your-line-user-id>"; }
}

// ---------- parsers ----------
function parseFM(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  let curKey = null;
  for (const raw of m[1].split("\n")) {
    // Detect a continuation entry of a YAML list under a key (e.g. substitutes)
    if (curKey && /^\s+-\s+/.test(raw)) {
      // Collect into fm[curKey] (array of objects already started)
      if (!Array.isArray(fm[curKey])) fm[curKey] = [];
      const entryMatch = raw.match(/^\s+-\s+(\w+):\s*(.+)$/);
      if (entryMatch) {
        fm[curKey].push({ [entryMatch[1]]: entryMatch[2].replace(/^["']|["']$/g, "") });
        continue;
      }
    }
    if (curKey && /^\s{4,}\w+:\s*/.test(raw)) {
      // Property of the last list item
      const propMatch = raw.match(/^\s+(\w+):\s*(.+)$/);
      if (propMatch && Array.isArray(fm[curKey]) && fm[curKey].length) {
        fm[curKey][fm[curKey].length - 1][propMatch[1]] = propMatch[2].replace(/^["']|["']$/g, "");
        continue;
      }
    }
    const mm = raw.match(/^([a-z_]+):\s*(.*)$/i);
    if (!mm) { curKey = null; continue; }
    const [, k, v] = mm;
    const val = v.trim();
    curKey = k;
    if (!val) {
      fm[k] = []; // will be filled by continuation lines
    } else if (/^\[.*\]$/.test(val)) {
      fm[k] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      curKey = null; // closed
    } else {
      fm[k] = val.replace(/^["']|["']$/g, "");
      curKey = null;
    }
  }
  return fm;
}

function loadMemberIndex() {
  // name → "編號" (BNI member number, e.g. "058") and the member object
  const dir = join(VAULT, "wiki/members");
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = parseFM(readFileSync(join(dir, f), "utf8"));
      const name = fm.name || f.replace(/\.md$/, "");
      const idx = fm.index ? String(fm.index).padStart(3, "0") : "";
      map.set(name, idx);
    } catch {}
  }
  return map;
}

function isFridayDate(dateStr) {
  return new Date(`${dateStr}T12:00:00+08:00`).getUTCDay() === 5;
}

// ---------- digest builder ----------
function buildLineDigest({ date, fm, memberIndex }) {
  const fmtMember = (name, suffix = "") => {
    const idx = memberIndex.get(name) || "";
    return `${idx}${name}${suffix ? `(${suffix})` : ""}`;
  };

  const lines = [];
  // Header
  lines.push(`${CHAPTER_NAME}：${date}例會`);
  lines.push(`每週會後公布夥伴出席狀況`);
  // Counts block
  lines.push(`應到：${fm.expected_count || "?"}人`);
  lines.push(`實到：${fm.present_count || "0"}人`);
  lines.push(`代理：${fm.substitute_count || "0"}人`);
  lines.push(`遲到：${fm.late_count || "0"}人`);
  lines.push(`缺席：${fm.absent_count || "0"}人`);
  lines.push(`來賓：${fm.visitor_count || "0"}人`);
  if (fm.helper_count && Number(fm.helper_count) > 0) {
    lines.push(`Helper：${fm.helper_count}人`);
  }
  // Sections (only show non-empty)
  const sep = "-----------------------------";
  if (Array.isArray(fm.absent_members) && fm.absent_members.length) {
    lines.push(sep);
    lines.push(`本次例會缺席：${fm.absent_members.length}人`);
    for (const a of fm.absent_members) lines.push(fmtMember(a));
  }
  if (Array.isArray(fm.substitutes) && fm.substitutes.length) {
    lines.push(sep);
    lines.push(`本次例會代理人：${fm.substitutes.length}人`);
    for (const s of fm.substitutes) {
      const member = s.member || s.name || "?";
      const by = s.by || "?";
      lines.push(`${fmtMember(member)} → 代理人：${by}`);
    }
  }
  if (Array.isArray(fm.late_arrivals) && fm.late_arrivals.length) {
    lines.push(sep);
    lines.push(`本次例會遲到：${fm.late_arrivals.length}人`);
    for (const n of fm.late_arrivals) lines.push(fmtMember(n));
  }
  if (Array.isArray(fm.visitors) && fm.visitors.length) {
    lines.push(sep);
    lines.push(`本次例會來賓：${fm.visitors.length}人`);
    for (const v of fm.visitors) lines.push(v);
  }
  if (Array.isArray(fm.helpers) && fm.helpers.length) {
    lines.push(sep);
    lines.push(`本次例會 Helper：${fm.helpers.length}人`);
    for (const h of fm.helpers) lines.push(h);
  }
  return lines.join("\n");
}

// ---------- LINE Messaging API ----------
async function sendLine(token, userId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`LINE ${r.status}: ${txt}`);
  }
  return r.json();
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const botId = args.find(a => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a));
  const force = args.includes("--force");

  if (!date || !botId) {
    console.error("usage: digest.mjs <YYYY-MM-DD> <bot_id> [--force]");
    process.exit(2);
  }

  const meetingDir = join(VAULT, "raw/meetings", date);
  const sentMarker = join(meetingDir, `${botId}.line_digest_sent`);

  if (existsSync(sentMarker) && !force) {
    console.log("⚠ line digest already processed (use --force to re-send)");
    process.exit(0);
  }

  // Friday-only gate
  if (!force && !isFridayDate(date)) {
    console.log(`⚠ ${date} is not a Friday — line digest skipped`);
    writeFileSync(sentMarker, JSON.stringify({ skipped: "not_friday", at: new Date().toISOString() }));
    process.exit(0);
  }

  // Test-meeting gate (read meeting page if it exists)
  const meetingPage = join(VAULT, "wiki/meetings", `${date}.md`);
  if (existsSync(meetingPage) && !force) {
    const mfm = parseFM(readFileSync(meetingPage, "utf8"));
    if (mfm.test === "true" || mfm.excluded_from_scoring === "true") {
      console.log(`⚠ ${date} meeting flagged test/excluded — line digest skipped`);
      writeFileSync(sentMarker, JSON.stringify({ skipped: "test_meeting", at: new Date().toISOString() }));
      process.exit(0);
    }
  }

  // Authoritative source: roll_call front-matter (written by resolve-attendance)
  const rollCallPath = join(VAULT, "raw/roll_calls", `${date}.md`);
  if (!existsSync(rollCallPath)) {
    console.error(`✗ no roll_call at ${rollCallPath} — resolve-attendance must run first`);
    process.exit(1);
  }
  const fm = parseFM(readFileSync(rollCallPath, "utf8"));

  const memberIndex = loadMemberIndex();
  const text = buildLineDigest({ date, fm, memberIndex });

  console.log(`▸ line digest preview (${text.length} chars):\n----------\n${text}\n----------`);

  const token = getLineToken();
  const userId = getAlexLineId();
  if (!token) { console.error("✗ no LINE_CHANNEL_ACCESS_TOKEN"); process.exit(1); }
  if (!userId) { console.error("✗ no ALEX_LINE_ID"); process.exit(1); }

  console.log(`▸ sending to LINE userId ${userId.slice(0,8)}…`);
  try {
    const r = await sendLine(token, userId, text);
    writeFileSync(sentMarker, JSON.stringify({
      sent: true, at: new Date().toISOString(),
      to: userId, response: r,
    }));
    console.log(`✓ line digest sent`);
  } catch (e) {
    console.error(`✗ line digest send failed: ${e.message}`);
    writeFileSync(sentMarker, JSON.stringify({
      failed: true, error: e.message, at: new Date().toISOString(),
    }));
    process.exit(1);
  }
}

main();
