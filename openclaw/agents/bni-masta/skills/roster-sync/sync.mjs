#!/usr/bin/env node
// roster-sync — two-way sync between wiki/members/ and the BNI Google Sheet
//
// Pass 1 (PULL, sheet → vault): reads <YourChapter>會員名單; for each row, creates/updates
//   wiki/members/<name>.md front-matter. Preserves body (narrative) sections.
// Pass 2 (PUSH, vault → sheet): existing upsert of both tabs from wiki front-matter.
//
// Usage: node sync.mjs [--pull-only|--push-only]
// Env: BNI_ROSTER_SHEET_ID, BNI_ROSTER_ACCOUNT (optional; defaults below)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const MEMBERS_DIR = join(VAULT, "wiki/members");
const SHEET_ID = process.env.BNI_ROSTER_SHEET_ID || "<your-google-sheet-id>";
const ACCOUNT = process.env.BNI_ROSTER_ACCOUNT || "<your-google-account>";

// ---------- front-matter parser (tiny, single-level) ----------
function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const mm = line.match(/^([a-z_][a-z_0-9]*):\s*(.*)$/i);
    if (!mm) continue;
    let [, k, v] = mm;
    v = v.trim();
    if (v === "null" || v === "") { fm[k] = null; continue; }
    if (/^\[.*\]$/.test(v)) {
      fm[k] = v.slice(1, -1).split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) { fm[k] = Number(v); continue; }
    fm[k] = v.replace(/^["']|["']$/g, "");
  }
  return fm;
}

// ---------- roster load ----------
function loadMembers() {
  if (!existsSync(MEMBERS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(MEMBERS_DIR)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const fm = parseFrontMatter(readFileSync(join(MEMBERS_DIR, f), "utf8"));
    if (fm.type !== "member") continue;
    out.push(fm);
  }
  return out;
}

// ---------- scoring ----------
const COLOR = { green: "🟢 綠", yellow: "🟡 黃", red: "🔴 紅", black: "⚫ 黑" };
function colorFor(score) {
  if (score === null || score === undefined) return "";
  if (score >= 70) return COLOR.green;
  if (score >= 50) return COLOR.yellow;
  if (score >= 30) return COLOR.red;
  return COLOR.black;
}
function computeScore(m) {
  const can = [m.attendance_pct, m.referrals_given_6mo, m.referrals_received_6mo,
               m.visitors_brought_6mo, m.ones_6mo, m.ceu_count_6mo, m.sponsoring_count_6mo]
              .some(v => v !== undefined && v !== null);
  if (!can) return null;
  const a = Math.min(30, (Number(m.attendance_pct) || 0) * 0.3);
  const rg = Math.min(20, (Number(m.referrals_given_6mo) || 0) * 3);
  const rr = Math.min(15, (Number(m.referrals_received_6mo) || 0) * 2);
  const v  = Math.min(10, (Number(m.visitors_brought_6mo) || 0) * 5);
  const o  = Math.min(10, (Number(m.ones_6mo) || 0) * 2);
  const c  = Math.min(10, (Number(m.ceu_count_6mo) || 0) * 2);
  const s  = Math.min( 5, (Number(m.sponsoring_count_6mo) || 0) * 5);
  return Math.round(a + rg + rr + v + o + c + s);
}

// ---------- gog helpers ----------
function gog(args, opts = {}) {
  const r = spawnSync("gog", args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`gog ${args.join(" ")}  failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
function readCol(range) {
  // returns array of single-cell strings from column A
  const out = gog(["sheets", "get", SHEET_ID, range, "--account", ACCOUNT, "--json"]);
  try {
    const j = JSON.parse(out);
    return (j.values || []).map(row => (row && row[0]) || "");
  } catch {
    return [];
  }
}
function updateRange(range, valuesJson) {
  gog([
    "sheets", "update", SHEET_ID, range,
    "--values-json", JSON.stringify(valuesJson),
    "--input", "USER_ENTERED",
    "--account", ACCOUNT,
  ]);
}
function appendRows(sheetName, rows) {
  if (!rows.length) return;
  gog([
    "sheets", "append", SHEET_ID, `${sheetName}!A:Z`,
    "--values-json", JSON.stringify(rows),
    "--input", "USER_ENTERED",
    "--insert", "INSERT_ROWS",
    "--account", ACCOUNT,
  ]);
}

// ---------- row builders ----------
function now() {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}
function rosterRow(m) {
  // <YourChapter>會員名單 layout: [編號, 姓名, 專業, 分會, 加入日, 狀態, 出席率, 電話, Email, 最近更新]
  // 編號 column added 2026-04-23 — pads to 3 digits if numeric, blank otherwise.
  // Prepend `'` to force Sheets to store as text; otherwise USER_ENTERED auto-
  // converts "001" → number 1 and the leading zeros are lost on display.
  const idxRaw = m.index;
  const idx = (idxRaw === null || idxRaw === undefined || idxRaw === "") ? ""
            : (/^\d+$/.test(String(idxRaw)) ? "'" + String(idxRaw).padStart(3, "0") : String(idxRaw));
  return [
    idx,
    m.name || "",
    m.expertise || "",
    m.chapter || "",
    m.joined || "",
    m.status || "",
    m.attendance_pct ?? "",
    m.phone || "",
    m.email || "",
    now(),
  ];
}
function trafficRow(m) {
  const score = computeScore(m);
  const light = score !== null ? colorFor(score) : (m.traffic_light ? colorFor_word(m.traffic_light) : "");
  return [
    m.name || "",
    light,
    score ?? "",
    m.referrals_given_6mo ?? 0,
    m.referrals_received_6mo ?? 0,
    m.visitors_brought_6mo ?? 0,
    m.ones_6mo ?? 0,
    m.ceu_count_6mo ?? 0,
    m.sponsoring_count_6mo ?? 0,
  ];
}
function colorFor_word(w) {
  const map = { green: COLOR.green, yellow: COLOR.yellow, red: COLOR.red, black: COLOR.black };
  return map[String(w).toLowerCase()] || "";
}

// ---------- PULL: sheet → wiki/members/ ----------
const SHEET_OWNED = new Set([
  "index", "expertise", "chapter", "joined", "status", "attendance_pct", "phone", "email",
]);

function readRosterSheet() {
  // <YourChapter>會員名單 layout: [編號, 姓名, 專業, 分會, 加入日, 狀態, 出席率, 電話, Email, 最近更新]
  const out = gog(["sheets", "get", SHEET_ID, "<YourChapter>會員名單!A2:J", "--account", ACCOUNT, "--json"]);
  try {
    const j = JSON.parse(out);
    return (j.values || []).map(row => ({
      index: row[0] || null,        // BNI 編號 (e.g. "058") — empty until the operator fills
      name: row[1] || "",
      expertise: row[2] || "",
      chapter: row[3] || "",
      joined: row[4] || "",
      status: row[5] || "active",
      attendance_pct: row[6] === "" || row[6] === undefined ? null : Number(row[6]),
      phone: row[7] || "",
      email: row[8] || "",
    })).filter(r => r.name);
  } catch { return []; }
}

function memberTemplate(name, f) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    "type: member",
    `index: ${f.index || "null"}`,
    `name: ${name}`,
    `chapter: ${f.chapter || "<YourChapter>"}`,
    `expertise: ${f.expertise || ""}`,
    `joined: ${f.joined || "null"}`,
    `status: ${f.status || "active"}`,
    "traffic_light: null",
    "aliases: []",
    "telegram_id: null",
    `phone: ${f.phone || "null"}`,
    `email: ${f.email || "null"}`,
    "last_121: null",
    `attendance_pct: ${f.attendance_pct ?? "null"}`,
    "referrals_given_6mo: 0",
    "referrals_received_6mo: 0",
    "visitors_brought_6mo: 0",
    "ones_6mo: 0",
    "ceu_count_6mo: 0",
    "sponsoring_count_6mo: 0",
    `created: ${today}`,
    `updated: ${today}`,
    "---", "",
    "## 歷史", `- ${today}：從試算表同步建立`, "",
    "## 1-to-1 記錄", "",
    "## 轉介紀錄", "",
    "## 備註", "",
  ].join("\n");
}

function upsertMemberFile(row) {
  mkdirSync(MEMBERS_DIR, { recursive: true });
  const fpath = join(MEMBERS_DIR, `${row.name}.md`);
  if (!existsSync(fpath)) { writeFileSync(fpath, memberTemplate(row.name, row)); return "created"; }
  const text = readFileSync(fpath, "utf8");
  const fmMatch = text.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) return "skipped_no_fm";
  const [, open, fmBody, close, body] = fmMatch;
  const today = new Date().toISOString().slice(0, 10);
  const newLines = [];
  let changed = false;
  const seen = new Set();
  for (const line of fmBody.split("\n")) {
    const m = line.match(/^([a-z_][a-z_0-9]*):\s*(.*)$/i);
    if (!m) { newLines.push(line); continue; }
    const key = m[1];
    seen.add(key);
    if (SHEET_OWNED.has(key)) {
      const v = row[key];
      if (v === "" || v === null || v === undefined) { newLines.push(line); continue; }
      const nl = `${key}: ${v}`;
      if (nl !== line.trim()) changed = true;
      newLines.push(nl);
    } else if (key === "updated") {
      newLines.push(`updated: ${today}`);
    } else {
      newLines.push(line);
    }
  }
  for (const key of SHEET_OWNED) {
    if (!seen.has(key) && row[key] !== "" && row[key] !== null && row[key] !== undefined) {
      newLines.push(`${key}: ${row[key]}`); changed = true;
    }
  }
  if (!changed) return "unchanged";
  writeFileSync(fpath, open + newLines.join("\n") + close + body);
  return "updated";
}

function pullFromSheet() {
  console.log("▸ pulling from <YourChapter>會員名單…");
  const rows = readRosterSheet();
  console.log(`  ${rows.length} rows in sheet`);
  const stats = { created: 0, updated: 0, unchanged: 0, skipped_no_fm: 0 };
  for (const r of rows) stats[upsertMemberFile(r)]++;
  console.log(`✓ pull: ${stats.created} created · ${stats.updated} updated · ${stats.unchanged} unchanged`);
  return stats;
}

// ---------- main ----------
function syncTab(tabName, members, rowBuilder, opts = {}) {
  // Batch approach: read the current full order of names in the name column,
  // merge members into that order (keep existing order for known names,
  // append new ones at the end), then write ONE batched range update.
  // This is 2 API calls per tab regardless of member count — safe from rate limits.
  //
  // opts:
  //   nameCol     — letter of the name column (default "A"; "B" for <YourChapter>會員名單 since 編號 is at A)
  //   colSpan     — last column letter for the write range (default "I"; "J" for <YourChapter>會員名單)
  //   placeholder — fn(name) → row array used when a sheet row has no matching member
  const {
    nameCol = "A",
    colSpan = "I",
    placeholder = (name) => [name, ...Array(8).fill("")],
  } = opts;

  const existing = readCol(`${tabName}!${nameCol}2:${nameCol}`);
  const order = existing.filter(Boolean); // current ordered names
  const orderSet = new Set(order);
  const byName = new Map(members.map(m => [m.name, m]));

  // Build final rows: existing names in their order, then new appends
  const finalRows = [];
  let updatedCount = 0;
  let appendedCount = 0;
  for (const name of order) {
    const m = byName.get(name);
    if (m) { finalRows.push(rowBuilder(m)); updatedCount++; }
    else finalRows.push(placeholder(name)); // keep as-is placeholder — shouldn't happen normally
  }
  for (const m of members) {
    if (!orderSet.has(m.name)) { finalRows.push(rowBuilder(m)); appendedCount++; }
  }

  if (finalRows.length) {
    const endRow = 1 + finalRows.length;
    updateRange(`${tabName}!A2:${colSpan}${endRow}`, finalRows);
  }
  return { updated: updatedCount, appended: appendedCount };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const doPull = !args.has("--push-only");
  const doPush = !args.has("--pull-only");

  if (doPull) pullFromSheet();

  if (doPush) {
    console.log(`▸ loading roster from ${MEMBERS_DIR}…`);
    const members = loadMembers();
    console.log(`✓ ${members.length} members loaded`);

    if (members.length === 0) {
      console.log("⚠ roster is empty — headers exist, no rows to write.");
    } else {
      console.log(`▸ syncing <YourChapter>會員名單…`);
      const r = syncTab("<YourChapter>會員名單", members, rosterRow, {
        nameCol: "B",          // 編號 is in A, 姓名 in B (since 2026-04-23)
        colSpan: "J",          // 10 columns total
        placeholder: (name) => ["", name, ...Array(8).fill("")],
      });
      console.log(`✓ <YourChapter>會員名單: ${r.updated} updated · ${r.appended} appended`);

      console.log(`▸ syncing 紅綠燈…`);
      const t = syncTab("紅綠燈", members, trafficRow);  // unchanged: name in A, 9 cols
      console.log(`✓ 紅綠燈: ${t.updated} updated · ${t.appended} appended`);
    }
  }

  console.log(`✓ roster-sync done · sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

try { main(); }
catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
