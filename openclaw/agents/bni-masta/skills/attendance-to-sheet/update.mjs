#!/usr/bin/env node
// attendance-to-sheet — bridge raw/roll_calls/<date>.md into the Google Sheet
// and into each member's wiki front-matter.
//
// Usage: node update.mjs <YYYY-MM-DD> [--force]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv(SECRETS_ENV);

const VAULT = "<vault-path>";
const MEMBERS_DIR = join(VAULT, "wiki/members");
const SHEET_ID = process.env.BNI_ROSTER_SHEET_ID || "<your-google-sheet-id>";
const ACCOUNT  = process.env.BNI_ROSTER_ACCOUNT  || "<your-google-account>";
const TAB_ATTENDANCE = "出席紀錄";

function gog(args, opts = {}) {
  const r = spawnSync("gog", args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`gog ${args.slice(0,3).join(" ")}… failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---------- parse roll_call.md ----------
function parseRollCall(path) {
  const text = readFileSync(path, "utf8");
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (mm) fm[mm[1]] = mm[2].trim();
    }
  }
  // Parse the attendance table lines: | [[members/xxx]] | 狀態 | 顯示名稱 | 加入 | 離開 | 發言秒 | 匹配 |
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*\[\[members\/([^\]|]+)\]\]\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*(\d+)\s*\|\s*([^|]+)\s*\|/);
    if (!m) continue;
    rows.push({
      member: m[1].trim(),
      status: m[2].trim(),
      display: m[3].trim(),
      join: m[4].trim(),
      leave: m[5].trim(),
      speech_sec: Number(m[6]),
      how: m[7].trim(),
    });
  }
  return { fm, rows };
}

// ---------- status → PALMS ----------
function toPalms(status) {
  const s = String(status || "").trim();
  if (s === "全程" || s === "準時到") return { code: "P", score: 1.0 };
  if (s === "遲到+早退") return { code: "LE", score: 0.25 };
  if (s === "遲到")      return { code: "L", score: 0.5 };
  if (s === "早退")      return { code: "E", score: 0.5 };
  if (s === "代理人")    return { code: "S", score: 0.5 };
  if (s === "缺席")      return { code: "A", score: 0.0 };
  return { code: "", score: null };
}

// ---------- sheet I/O ----------
function readHeaders(tab) {
  const out = gog(["sheets", "get", SHEET_ID, `${tab}!1:1`, "--account", ACCOUNT, "--json"]);
  try { return (JSON.parse(out).values?.[0] || []); } catch { return []; }
}
function readCol(tab, range) {
  const out = gog(["sheets", "get", SHEET_ID, `${tab}!${range}`, "--account", ACCOUNT, "--json"]);
  try { return (JSON.parse(out).values || []).map(r => (r && r[0]) || ""); } catch { return []; }
}
function writeCell(tab, a1, value) {
  gog(["sheets", "update", SHEET_ID, `${tab}!${a1}`,
       "--values-json", JSON.stringify([[value]]),
       "--input", "USER_ENTERED", "--account", ACCOUNT]);
}
function colLetter(n) {
  // 1→A, 26→Z, 27→AA …
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------- write to 出席紀錄 tab ----------
function upsertAttendanceColumn(date, palmsByName) {
  // headers row: [姓名, 出席率, <dates...>]
  const headers = readHeaders(TAB_ATTENDANCE);
  let dateColIdx = headers.indexOf(date);
  if (dateColIdx === -1) {
    // append as new rightmost column
    dateColIdx = headers.length;
    writeCell(TAB_ATTENDANCE, `${colLetter(dateColIdx + 1)}1`, date);
  }
  const dateCol = colLetter(dateColIdx + 1);

  // name column (A, starting row 2)
  const names = readCol(TAB_ATTENDANCE, "A2:A");
  const nameToRow = new Map();
  names.forEach((n, i) => { if (n) nameToRow.set(n, i + 2); });

  let updated = 0, appended = 0;
  for (const [name, code] of palmsByName.entries()) {
    let row = nameToRow.get(name);
    if (!row) {
      // Append new row at end — row = row count + 2 (past header)
      row = names.length + 2 + appended;
      writeCell(TAB_ATTENDANCE, `A${row}`, name);
      appended++;
    }
    writeCell(TAB_ATTENDANCE, `${dateCol}${row}`, code);
    updated++;
  }
  return { updated, appended, dateCol };
}

// ---------- update member front-matter ----------
function updateMemberFrontMatter(name, palms) {
  const fpath = join(MEMBERS_DIR, `${name}.md`);
  if (!existsSync(fpath)) return "no_member_file";
  const text = readFileSync(fpath, "utf8");
  const m = text.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!m) return "no_frontmatter";
  const [, open, fmBody, close, body] = m;
  const today = new Date().toISOString().slice(0, 10);

  const lines = fmBody.split("\n");
  const fm = {};
  for (const line of lines) {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (mm) fm[mm[1]] = mm[2].trim();
  }

  // Track rolling attendance (simple: keep last_attendance_scores as a short list)
  // Scores stored in an inline front-matter field, newest first, max 6
  let scores = [];
  if (fm.last_attendance_scores && fm.last_attendance_scores.startsWith("[")) {
    scores = fm.last_attendance_scores.slice(1, -1).split(",").map(s => Number(s.trim())).filter(x => !isNaN(x));
  }
  scores.unshift(palms.score);
  scores = scores.slice(0, 6);
  const avg = scores.length ? (scores.reduce((a,b)=>a+b,0) / scores.length * 100).toFixed(1) : "null";

  const updates = {
    attendance_pct: avg,
    last_attendance_scores: "[" + scores.join(", ") + "]",
    _last_meeting_palms: palms.code,
    updated: today,
  };

  const seen = new Set();
  const newLines = lines.map(line => {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!mm) return line;
    const k = mm[1];
    seen.add(k);
    if (k in updates) return `${k}: ${updates[k]}`;
    return line;
  });
  // Append any missing keys
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) newLines.push(`${k}: ${v}`);
  }
  writeFileSync(fpath, open + newLines.join("\n") + close + body);
  return "updated";
}

// ---------- main ----------
function main() {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const force = args.includes("--force");
  if (!date) { console.error("usage: update.mjs <YYYY-MM-DD> [--force]"); process.exit(2); }

  const rollCallPath = join(VAULT, "raw/roll_calls", `${date}.md`);
  if (!existsSync(rollCallPath)) {
    console.error(`✗ no roll_call at ${rollCallPath}`);
    process.exit(0);
  }
  const marker = join(VAULT, "raw/roll_calls", `${date}.sheet-updated`);
  if (existsSync(marker) && !force) {
    console.log("⚠ already processed (use --force to re-run)");
    process.exit(0);
  }

  console.log(`▸ parsing ${rollCallPath}…`);
  const { fm, rows } = parseRollCall(rollCallPath);

  // Also read wiki/meetings/<date>.md — resolve.mjs doesn't copy the test flag
  // onto its output, so we must check the authoritative meeting page too.
  let meetingTest = false;
  const meetingPage = join(VAULT, "wiki/meetings", `${date}.md`);
  if (existsSync(meetingPage)) {
    const mtext = readFileSync(meetingPage, "utf8");
    const mfm = mtext.match(/^---\n([\s\S]*?)\n---/);
    if (mfm) {
      const meta = {};
      for (const line of mfm[1].split("\n")) {
        const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (mm) meta[mm[1]] = mm[2].trim();
      }
      if (meta.test === "true" || meta.excluded_from_scoring === "true") meetingTest = true;
    }
  }

  // Skip scoring for test / excluded meetings
  if (fm.test === "true" || fm.excluded_from_scoring === "true" || meetingTest) {
    console.log(`⚠ meeting flagged test / excluded_from_scoring — skipping writes`);
    writeFileSync(marker, JSON.stringify({ skipped: "test_or_excluded", at: new Date().toISOString() }));
    process.exit(0);
  }

  const palmsByName = new Map();
  const memberUpdates = [];
  for (const r of rows) {
    const p = toPalms(r.status);
    if (!p.code) continue; // 來賓 or unknown
    palmsByName.set(r.member, p.code);
    memberUpdates.push({ name: r.member, palms: p });
  }
  console.log(`  ${palmsByName.size} scoring rows (${rows.length} total in roll_call)`);

  console.log(`▸ updating ${TAB_ATTENDANCE} tab for ${date}…`);
  let sheetStats = { updated: 0, appended: 0, dateCol: "" };
  try { sheetStats = upsertAttendanceColumn(date, palmsByName); }
  catch (e) { console.error(`  ✗ sheet update failed: ${e.message}`); }
  console.log(`✓ sheet: ${sheetStats.updated} cells written at col ${sheetStats.dateCol} · ${sheetStats.appended} new rows`);

  console.log(`▸ updating member front-matter…`);
  const fmStats = { updated: 0, skipped: 0 };
  for (const { name, palms } of memberUpdates) {
    const r = updateMemberFrontMatter(name, palms);
    if (r === "updated") fmStats.updated++; else fmStats.skipped++;
  }
  console.log(`✓ vault: ${fmStats.updated} members updated · ${fmStats.skipped} skipped`);

  // log + marker
  const logLine = `\n${new Date().toISOString().slice(0,16).replace("T"," ")} | attendance-to-sheet ${date} | sheet col ${sheetStats.dateCol}, ${sheetStats.updated} cells · ${fmStats.updated} member files\n`;
  const logPath = join(VAULT, "wiki/log.md");
  writeFileSync(logPath, readFileSync(logPath, "utf8") + logLine);
  writeFileSync(marker, JSON.stringify({
    date, processed_at: new Date().toISOString(),
    sheet: sheetStats, vault: fmStats,
  }, null, 2));
  console.log(`✓ attendance-to-sheet done`);
}

main();
