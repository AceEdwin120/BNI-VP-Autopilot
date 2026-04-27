#!/usr/bin/env node
// detailed-meeting-report — per-member rename history + speech log + Haiku
// summaries. Outputs to vault md + 會議詳情 sheet + Speech Log sheet.
//
// Usage: node detailed.mjs <YYYY-MM-DD> <bot_id> [--no-summary] [--force]

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const VAULT = "<vault-path>";
const MEMBERS_DIR = join(VAULT, "wiki/members");
const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
const SHEET_ID = process.env.BNI_ROSTER_SHEET_ID || "<your-google-sheet-id>";
const ACCOUNT  = process.env.BNI_ROSTER_ACCOUNT  || "<your-google-account>";
const TAB_DETAIL = "會議詳情";
const TAB_SPEECH = "Speech Log";
const HAIKU_MODEL = "anthropic/claude-haiku-4.5";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

// ---------- helpers ----------
function gog(args, opts = {}) {
  const r = spawnSync("gog", args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`gog ${args.slice(0,3).join(" ")}… failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function parseFM(text) {
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
function loadMembers() {
  if (!existsSync(MEMBERS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(MEMBERS_DIR)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const fm = parseFM(readFileSync(join(MEMBERS_DIR, f), "utf8"));
    if (fm.type !== "member") continue;
    let aliases = [];
    if (typeof fm.aliases === "string" && fm.aliases.startsWith("[")) {
      aliases = fm.aliases.slice(1, -1).split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (Array.isArray(fm.aliases)) {
      aliases = fm.aliases;
    }
    out.push({
      id: f.replace(/\.md$/, ""),
      name: fm.name || f.replace(/\.md$/, ""),
      aliases,
      expertise: fm.expertise || "",
      index: fm.index ? String(fm.index).padStart(3, "0") : "",
      status: fm.status || "active",
    });
  }
  return out;
}

// Lenient match — mirrors roster-match.mjs::looksLikeBniFormat. Returns the
// member object if the display name plausibly identifies them, else null.
function tryMatchDisplay(display, members) {
  const s = String(display || "").trim();
  if (!s) return null;
  // Strip 代理人 + helper prefixes for matching purposes
  const cleaned = s
    .replace(/[\s\-－—–]*代理人[\s\-－—–]*/g, " ")
    .replace(/^\s*(helper|協助|幫忙)[\s\|｜\/／\-:：]+/i, "")
    .toLowerCase();
  // 1. Exact name match anywhere in cleaned
  for (const m of members) {
    if (m.name && cleaned.includes(m.name)) return m;
    for (const a of m.aliases) {
      if (a && a.length >= 2 && cleaned.includes(String(a).toLowerCase())) return m;
    }
  }
  return null;
}

// ---------- Haiku summary ----------
async function haikuSummarize(memberName, speechChunks) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (!speechChunks.length) return null;
  // Build a compact transcript
  const text = speechChunks
    .map(c => `[${tpe(c.timestamp)}] ${c.text}`)
    .join("\n")
    .slice(0, 6000);  // hard cap so we don't blow tokens
  const prompt = `以下是 ${memberName} 在 BNI 例會中的所有發言（按時間順序）。請用 3-5 個繁體中文 bullet 摘要他/她說的重點，每個 bullet ≤ 30 字。只輸出 bullet 列表，不要前後綴。

<transcript>
${text}
</transcript>`;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://github.com/<your-github>/<your-repo>",
        "X-Title": "BNI-Masta detailed-report",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 400,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// Time formatting — UTC ISO → "HH:MM:SS" Taipei
function tpe(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
}
function tpeDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const botId = args.find(a => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a));
  const noSummary = args.includes("--no-summary");
  const force = args.includes("--force");

  if (!date || !botId) {
    console.error("usage: detailed.mjs <YYYY-MM-DD> <bot_id> [--no-summary] [--force]");
    process.exit(2);
  }

  const meetingDir = join(VAULT, "raw/meetings", date);
  const marker = join(meetingDir, `${botId}.detailed_done`);
  if (existsSync(marker) && !force) {
    console.log("⚠ detailed-meeting-report already processed (use --force to re-run)");
    process.exit(0);
  }

  const partsPath = join(meetingDir, "participants.jsonl");
  const transcriptPath = join(meetingDir, "transcript.jsonl");
  if (!existsSync(partsPath)) { console.error(`✗ no ${partsPath}`); process.exit(1); }

  const events = readFileSync(partsPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const transcript = existsSync(transcriptPath)
    ? readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

  const members = loadMembers();
  const memberById = new Map(members.map(m => [m.id, m]));
  const memberByName = new Map(members.map(m => [m.name, m]));

  // ---------- aggregate by participant_id ----------
  // For each pid, capture: all displayNames (with timestamps), first/last
  // event ts, leave events, then identify which member (if any) it represents
  // by walking all historical names.
  const byPid = new Map();
  for (const e of events) {
    const pid = e.participant_id;
    if (!pid) continue;
    if (!byPid.has(pid)) byPid.set(pid, { pid, names: [], joins: [], leaves: [] });
    const p = byPid.get(pid);
    if (e.display_name) p.names.push({ t: e.timestamp, name: e.display_name });
    if (e.type === "participant_join") p.joins.push(e.timestamp);
    if (e.type === "participant_leave") p.leaves.push(e.timestamp);
  }
  for (const p of byPid.values()) {
    p.names.sort((a, b) => (a.t < b.t ? -1 : 1));
    p.joins.sort();
    p.leaves.sort();
    p.firstSeen = p.joins[0] || p.names[0]?.t || null;
    p.lastSeen = p.leaves[p.leaves.length - 1] || p.names[p.names.length - 1]?.t || null;
    // Distinct rename history (collapse runs of identical names)
    const renameLog = [];
    for (const n of p.names) {
      if (!renameLog.length || renameLog[renameLog.length - 1].name !== n.name) {
        renameLog.push(n);
      }
    }
    p.renameLog = renameLog;
    // Identify: try EVERY historical name against the roster
    let matched = null;
    for (const { name } of renameLog) {
      const m = tryMatchDisplay(name, members);
      if (m) { matched = m; break; }
    }
    p.member = matched;
  }

  // ---------- merge pids by member identity ----------
  // Multiple pids → same member (rejoin from different devices) → fold into one identity.
  const byMember = new Map(); // memberId → { member, pids[], firstSeen, lastSeen, renameLog[] }
  const visitorPids = []; // pids with no matched member (visitors / helpers / unknowns)
  for (const p of byPid.values()) {
    if (p.member) {
      const id = p.member.id;
      if (!byMember.has(id)) byMember.set(id, { member: p.member, pids: [], renameLog: [], firstSeen: null, lastSeen: null });
      const agg = byMember.get(id);
      agg.pids.push(p.pid);
      agg.renameLog.push(...p.renameLog.map(r => ({ ...r, pid: p.pid })));
      if (!agg.firstSeen || (p.firstSeen && p.firstSeen < agg.firstSeen)) agg.firstSeen = p.firstSeen;
      if (!agg.lastSeen || (p.lastSeen && p.lastSeen > agg.lastSeen)) agg.lastSeen = p.lastSeen;
    } else {
      visitorPids.push(p);
    }
  }
  for (const agg of byMember.values()) {
    agg.renameLog.sort((a, b) => (a.t < b.t ? -1 : 1));
  }

  // ---------- attach speech ----------
  for (const agg of byMember.values()) agg.speech = [];
  for (const v of visitorPids) v.speech = [];
  const pidToMemberAgg = new Map();
  for (const agg of byMember.values()) {
    for (const pid of agg.pids) pidToMemberAgg.set(String(pid), agg);
  }
  for (const t of transcript) {
    const pid = String(t.participant_id || "");
    const text = String(t.text || "").trim();
    if (!text) continue;
    const agg = pidToMemberAgg.get(pid);
    if (agg) {
      agg.speech.push({ timestamp: t.timestamp, text, displayName: t.display_name || "" });
    } else {
      // Visitor / helper / unknown
      const v = visitorPids.find(x => String(x.pid) === pid);
      if (v) v.speech.push({ timestamp: t.timestamp, text, displayName: t.display_name || "" });
    }
  }
  for (const agg of byMember.values()) agg.speech.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  // ---------- read roll_call front-matter for the canonical counts ----------
  const rollCallPath = join(VAULT, "raw/roll_calls", `${date}.md`);
  const rcFm = existsSync(rollCallPath) ? parseFM(readFileSync(rollCallPath, "utf8")) : {};

  // ---------- build the markdown ----------
  const reportPath = join(VAULT, "wiki/meeting_reports", `${date}_detailed.md`);
  mkdirSync(join(VAULT, "wiki/meeting_reports"), { recursive: true });

  const expectedCount = Number(rcFm.expected_count || members.filter(m => m.status === "active").length);
  const presentCount = Number(rcFm.present_count || byMember.size);
  const fullCount = Number(rcFm.present_full || 0);
  const lateCount = Number(rcFm.late_count || 0);
  const earlyLeave = Number(rcFm.early_leave_count || 0);
  const subCount = Number(rcFm.substitute_count || 0);
  const absentCount = Number(rcFm.absent_count || 0);
  const visitorCount = Number(rcFm.visitor_count || 0);
  const helperCount = Number(rcFm.helper_count || 0);
  const meetingType = rcFm.meeting_type || "例會";
  const startISO = rcFm.meeting_start || "";
  const endISO = rcFm.meeting_end || "";

  // Per-member Haiku summaries (PHASE 3)
  if (!noSummary) {
    console.log(`▸ summarizing ${byMember.size} members via Haiku…`);
    for (const agg of byMember.values()) {
      if (!agg.speech.length) continue;
      agg.summary = await haikuSummarize(agg.member.name, agg.speech);
    }
  }

  // Sort members by 編號 (asc)
  const sortedMembers = [...byMember.values()].sort((a, b) => {
    const ai = Number(a.member.index) || 999, bi = Number(b.member.index) || 999;
    return ai - bi;
  });

  const lines = [];
  lines.push("---");
  lines.push("type: detailed_meeting_report");
  lines.push(`date: ${date}`);
  lines.push("chapter: <YourChapter>");
  lines.push(`meeting_type: ${meetingType}`);
  lines.push(`meeting_start: "${startISO}"`);
  lines.push(`meeting_end: "${endISO}"`);
  lines.push(`generated_at: "${new Date().toISOString()}"`);
  lines.push(`source:`);
  lines.push(`  - raw/meetings/${date}/participants.jsonl`);
  lines.push(`  - raw/meetings/${date}/transcript.jsonl`);
  lines.push(`  - raw/roll_calls/${date}.md`);
  lines.push("---");
  lines.push("");
  lines.push(`# <YourChapter> ${date} 例會 — 詳細報告`);
  lines.push("");
  lines.push("## 統計");
  lines.push("");
  lines.push("| 項目 | 人數 |");
  lines.push("|---|---|");
  lines.push(`| 應到 | ${expectedCount} |`);
  lines.push(`| 實到 | ${presentCount} |`);
  lines.push(`| 全程 | ${fullCount} |`);
  lines.push(`| 遲到 | ${lateCount} |`);
  lines.push(`| 早退 | ${earlyLeave} |`);
  lines.push(`| 代理 | ${subCount} |`);
  lines.push(`| 缺席 | ${absentCount} |`);
  lines.push(`| 來賓 | ${visitorCount} |`);
  lines.push(`| Helper | ${helperCount} |`);
  lines.push("");
  lines.push("## 出席會員詳情");
  lines.push("");

  for (const agg of sortedMembers) {
    const m = agg.member;
    lines.push(`### ${m.index || "—"} ${m.name}`);
    lines.push("");
    lines.push(`- **加入時間**：${tpe(agg.firstSeen)} (台灣)`);
    lines.push(`- **離開時間**：${tpe(agg.lastSeen)} (台灣)`);
    if (agg.pids.length > 1) lines.push(`- **多裝置登入**：${agg.pids.length} 個 participant_id`);
    if (agg.renameLog.length > 1) {
      lines.push(`- **顯示名稱歷程**：`);
      for (const r of agg.renameLog) lines.push(`  - ${tpe(r.t)} → \`${r.name}\``);
    } else if (agg.renameLog.length === 1) {
      lines.push(`- **顯示名稱**：\`${agg.renameLog[0].name}\``);
    }
    if (agg.summary) {
      lines.push(`- **發言重點 (Haiku 摘要)**：`);
      for (const ln of agg.summary.split("\n")) {
        if (ln.trim()) lines.push(`  ${ln.trim()}`);
      }
    }
    if (agg.speech.length) {
      lines.push(`- **完整發言** (${agg.speech.length} 段)：`);
      for (const s of agg.speech) lines.push(`  - **${tpe(s.timestamp)}**：${s.text}`);
    } else {
      lines.push(`- **完整發言**：無發言記錄`);
    }
    lines.push("");
  }

  // Visitors / helpers
  if (visitorPids.length) {
    lines.push("## 來賓 / Helper / 未識別");
    lines.push("");
    for (const v of visitorPids) {
      const lastName = v.renameLog[v.renameLog.length - 1]?.name || "(unknown)";
      const tag = /^\s*(helper|協助|幫忙)/i.test(lastName) ? "Helper" : "來賓";
      lines.push(`### ${tag} · ${lastName}`);
      lines.push("");
      lines.push(`- **加入時間**：${tpe(v.firstSeen)} (台灣)`);
      lines.push(`- **離開時間**：${tpe(v.lastSeen)} (台灣)`);
      if (v.speech.length) {
        lines.push(`- **發言** (${v.speech.length} 段)：`);
        for (const s of v.speech) lines.push(`  - **${tpe(s.timestamp)}**：${s.text}`);
      }
      lines.push("");
    }
  }

  if (rcFm.absent_members && Array.isArray(rcFm.absent_members) && rcFm.absent_members.length) {
    lines.push("## 缺席");
    lines.push("");
    for (const name of rcFm.absent_members) {
      const m = memberByName.get(name);
      lines.push(`- ${m?.index || "—"} ${name}`);
    }
    lines.push("");
  }

  writeFileSync(reportPath, lines.join("\n"));
  console.log(`✔ wrote ${reportPath}`);

  // ---------- Sheet: 會議詳情 (one row per meeting) ----------
  console.log(`▸ upserting 會議詳情 row…`);
  try {
    const startTpe = startISO ? tpe(startISO) : "";
    const endTpe = endISO ? tpe(endISO) : "";
    const summaryLink = `https://docs.google.com/...  (vault://wiki/meeting_reports/${date}_detailed)`;
    // Read existing date column to find the row to upsert
    const existing = JSON.parse(gog(["sheets", "get", SHEET_ID, `${TAB_DETAIL}!A2:A`, "--account", ACCOUNT, "--json"])).values || [];
    const dateRowIdx = existing.findIndex(r => r[0] === date);
    const row = [date, meetingType, expectedCount, presentCount, fullCount, lateCount, subCount, absentCount, visitorCount, helperCount, startTpe, endTpe, summaryLink];
    const targetRow = dateRowIdx >= 0 ? dateRowIdx + 2 : existing.length + 2;
    gog(["sheets", "update", SHEET_ID, `${TAB_DETAIL}!A${targetRow}:M${targetRow}`,
         "--values-json", JSON.stringify([row]), "--input", "USER_ENTERED", "--account", ACCOUNT]);
    console.log(`  ✓ wrote 會議詳情 row ${targetRow}`);
  } catch (e) {
    console.error(`  ✗ 會議詳情 upsert failed: ${e.message}`);
  }

  // ---------- Sheet: Speech Log (dedup-then-append) ----------
  // Re-runs of the same date previously left duplicate rows; we now read the
  // full sheet, drop any existing rows for this date, then write back the
  // surviving rows + the freshly-built rows in one update. This makes the skill
  // safely idempotent w.r.t. Speech Log.
  console.log(`▸ rewriting Speech Log rows for ${date}…`);
  try {
    const speechRows = [];
    for (const agg of sortedMembers) {
      const idx = agg.member.index ? "'" + agg.member.index : "";
      for (const s of agg.speech) {
        speechRows.push([date, tpe(s.timestamp), idx, agg.member.name, s.displayName, s.text]);
      }
    }
    for (const v of visitorPids) {
      const lastName = v.renameLog[v.renameLog.length - 1]?.name || "";
      for (const s of v.speech) {
        speechRows.push([date, tpe(s.timestamp), "", "", lastName, s.text]);
      }
    }
    // Pull the existing data block (header excluded), drop matching-date rows
    const existingRaw = gog(["sheets", "get", SHEET_ID, `${TAB_SPEECH}!A2:F`,
                             "--account", ACCOUNT, "--json"]);
    const existing = (JSON.parse(existingRaw).values || []).filter(r => r[0] !== date);
    const removed = (JSON.parse(existingRaw).values || []).length - existing.length;
    const combined = [...existing, ...speechRows];
    // Clear the entire data block first so leftover trailing rows disappear
    gog(["sheets", "clear", SHEET_ID, `${TAB_SPEECH}!A2:F`, "--account", ACCOUNT]);
    if (combined.length) {
      gog(["sheets", "update", SHEET_ID, `${TAB_SPEECH}!A2:F${combined.length + 1}`,
           "--values-json", JSON.stringify(combined),
           "--input", "USER_ENTERED", "--account", ACCOUNT]);
    }
    console.log(`  ✓ Speech Log: removed ${removed} stale, wrote ${speechRows.length} fresh (total ${combined.length})`);
  } catch (e) {
    console.error(`  ✗ Speech Log rewrite failed: ${e.message}`);
  }

  writeFileSync(marker, JSON.stringify({ done: true, at: new Date().toISOString(), members: sortedMembers.length, visitors: visitorPids.length }));
  console.log(`✓ detailed-meeting-report done`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
