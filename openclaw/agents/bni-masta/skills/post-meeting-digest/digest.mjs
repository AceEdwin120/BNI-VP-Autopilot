#!/usr/bin/env node
// post-meeting-digest — send a Telegram digest to the operator after the post-meeting
// chain completes. Friday-only by default. Idempotent per bot.
//
// Usage: node digest.mjs <YYYY-MM-DD> <bot_id> [--force]
//   --force: bypass both the Friday-only gate AND the idempotency marker
//
// Reads:
//   raw/meetings/<date>/<bot_id>.done
//   wiki/meetings/<date>.md
//   wiki/meeting_reports/<date>.md
//
// Writes:
//   raw/meetings/<date>/<bot_id>.digest_sent  (idempotency + audit marker)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const OPENCLAW_JSON = "~/.openclaw/openclaw.json";
const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
const SHEET_ID = process.env.BNI_ROSTER_SHEET_ID || "<your-google-sheet-id>";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

// ---------- secrets / config ----------
function getBotToken() {
  if (process.env.BNI_TELEGRAM_BOT_TOKEN) return process.env.BNI_TELEGRAM_BOT_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
    return cfg.channels?.telegram?.accounts?.bnimasta?.botToken || null;
  } catch { return null; }
}
function getChatId() {
  return process.env.ALEX_TELEGRAM_ID || "";
}

// ---------- parsing ----------
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

// Body after frontmatter; first non-heading, non-callout, non-table prose paragraph.
function firstParagraph(text, maxChars = 250) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const para of body.split(/\n\n+/)) {
    const t = para.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^>/.test(t)) continue;
    if (/^\|/.test(t)) continue;
    return t.slice(0, maxChars);
  }
  return "—";
}

// Extract first 3 action items from "## 行動項目" or "## 🎯 行動項目" section
function actionItems(text, max = 3) {
  if (!text) return [];
  const m = text.match(/##\s*🎯?\s*行動項目[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|$)/);
  if (!m) return [];
  const lines = m[1].split("\n").map(l => l.trim()).filter(Boolean);
  const items = lines.filter(l => /^[-*•]\s+/.test(l)).map(l => l.replace(/^[-*•]\s+/, ""));
  return items.slice(0, max);
}

function isFriday(dateStr) {
  // dateStr = YYYY-MM-DD (Taipei). Construct as Taipei midday so timezone math
  // can't accidentally roll the weekday.
  const d = new Date(dateStr + "T12:00:00+08:00");
  return d.getUTCDay() === 5; // 0=Sun, 5=Fri (UTC since we anchored explicitly)
}

// ---------- digest builder ----------
function buildDigest({ date, doneMarker, meetingPage, meetingReport }) {
  const meetingFm = parseFrontMatter(meetingPage || "");
  const isTest = meetingFm.test === "true" || meetingFm.excluded_from_scoring === "true";

  // Pipeline icons: true ✓ / false ✗ / undefined or skipped ⏭
  const icon = ok => ok === true ? "✓" : ok === false ? "✗" : "⏭";
  const pipeline = [
    `${icon(doneMarker.resolve_ok)} 點名`,
    `${icon(doneMarker.ingest_ok)} 編譯`,
    `${icon(doneMarker.report_ok)} 報告`,
    `${icon(doneMarker.sheet_ok)} Sheet`,
    `${icon(doneMarker.roster_sync_ok)} 名冊`,
  ].join(" · ");

  // Header
  const header = `📋 會議結束 · ${date} · ${meetingFm.meeting_type || "—"}` +
    (isTest ? "\n🧪 測試會議" : "");

  // Attendance
  const present = meetingFm.present_count ?? "?";
  const late = meetingFm.late_count ?? "0";
  const absent = meetingFm.absent_count ?? "0";
  const earlyLeave = meetingFm.early_leave_count ?? "0";
  const visitorsRaw = meetingFm.visitors || "[]";
  const visitorsList = visitorsRaw.replace(/[\[\]"']/g, "").split(",").map(s => s.trim()).filter(Boolean);
  const attendance = `👥 出席（${present} 位）\n遲到 ${late} · 缺席 ${absent} · 早退 ${earlyLeave} · 來賓 ${visitorsList.length}`;

  // Summary
  const summary = `📝 摘要\n${firstParagraph(meetingReport, 250)}`;

  // Action items
  const items = actionItems(meetingReport, 3);
  const actionsBlock = items.length
    ? `🎯 行動項目（顯示 ${items.length} 條）\n${items.map(s => "• " + s.slice(0, 120)).join("\n")}`
    : `🎯 行動項目（0）`;

  // Links — Obsidian deep links + sheet
  const vaultName = "BNI AGENT";
  const obsidianMeeting = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(`wiki/meetings/${date}`)}`;
  const obsidianReport = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(`wiki/meeting_reports/${date}`)}`;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const links = `🔗 連結\n· <a href="${obsidianMeeting}">會議頁面</a>\n· <a href="${obsidianReport}">會議報告</a>\n· <a href="${sheetUrl}">出席表</a>`;

  return [header, "", `📊 ${pipeline}`, "", attendance, "", summary, "", actionsBlock, "", links].join("\n");
}

// ---------- Telegram send ----------
async function sendTelegram(token, chatId, htmlText) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: htmlText.slice(0, 4096),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`Telegram ${r.status}: ${txt}`);
  }
  return r.json();
}

// HTML-escape the parts that aren't already <a> tags. Our buildDigest only
// emits <a href="…">…</a> as raw HTML — everything else is plain text.
function escapeForHtml(s) {
  // Split on our anchor tags, escape the bits between them.
  const parts = s.split(/(<a href="[^"]+">[^<]+<\/a>)/);
  return parts.map(p => {
    if (p.startsWith("<a href=")) return p; // pass through
    return p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }).join("");
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
  const sentMarker = join(meetingDir, `${botId}.digest_sent`);

  if (existsSync(sentMarker) && !force) {
    console.log("⚠ digest already processed (use --force to re-send)");
    process.exit(0);
  }

  // Friday-only gate
  if (!force && !isFriday(date)) {
    console.log(`⚠ ${date} is not a Friday — digest skipped`);
    writeFileSync(sentMarker, JSON.stringify({ skipped: "not_friday", at: new Date().toISOString() }));
    process.exit(0);
  }

  // Read pipeline state.
  // Note: when the Telegram digest runs INSIDE the meeting-poll chain, the
  // .done marker is written AFTER all skills (including this one). So .done
  // won't exist on the in-chain run. Treat it as a soft signal — if missing,
  // assume the upstream steps succeeded (we got here, didn't we?) and use a
  // synthesized marker. The presence of the roll_call.md is the real signal
  // that the chain ran far enough to digest.
  const doneMarkerPath = join(meetingDir, `${botId}.done`);
  if (!existsSync(doneMarkerPath)) {
    // Soft fallback: roll_call.md presence == upstream succeeded. Otherwise
    // there's no point sending a digest yet.
    const rollCallPath = join(VAULT, "raw/roll_calls", `${date}.md`);
    if (!existsSync(rollCallPath)) {
      console.error(`✗ no .done marker AND no roll_call at ${rollCallPath} — upstream chain hasn't produced data yet`);
      process.exit(1);
    }
    console.log(`ℹ no .done marker yet (in-chain run); proceeding with synthesized status`);
  }
  // Load .done if it exists; else synthesize an "all-ok" placeholder so the
  // pipeline-status icons render with ✓ across the board (the real status is
  // captured AFTER the chain writes .done; if anything failed upstream, the
  // user has other signals — this digest is for the human-readable summary).
  const doneMarker = existsSync(doneMarkerPath)
    ? JSON.parse(readFileSync(doneMarkerPath, "utf8") || "{}")
    : { resolve_ok: true, ingest_ok: undefined, report_ok: undefined,
        sheet_ok: undefined, roster_sync_ok: undefined, digest_ok: undefined,
        synthesized: true };

  const meetingPage = existsSync(join(VAULT, "wiki/meetings", `${date}.md`))
    ? readFileSync(join(VAULT, "wiki/meetings", `${date}.md`), "utf8") : "";
  const meetingReport = existsSync(join(VAULT, "wiki/meeting_reports", `${date}.md`))
    ? readFileSync(join(VAULT, "wiki/meeting_reports", `${date}.md`), "utf8") : "";

  const text = buildDigest({ date, doneMarker, meetingPage, meetingReport });
  const html = escapeForHtml(text);

  console.log(`▸ digest preview (${text.length} chars):\n----------\n${text}\n----------`);

  const token = getBotToken();
  const chatId = getChatId();
  if (!token) { console.error("✗ no Telegram bot token (BNI_TELEGRAM_BOT_TOKEN env or openclaw.json)"); process.exit(1); }
  if (!chatId) { console.error("✗ no chat_id (ALEX_TELEGRAM_ID env)"); process.exit(1); }

  console.log(`▸ sending to chat ${chatId}…`);
  try {
    const r = await sendTelegram(token, chatId, html);
    writeFileSync(sentMarker, JSON.stringify({
      sent: true, at: new Date().toISOString(),
      msg_id: r.result?.message_id, chat_id: chatId,
    }));
    console.log(`✓ sent (msg_id=${r.result?.message_id})`);
  } catch (e) {
    console.error(`✗ send failed: ${e.message}`);
    writeFileSync(sentMarker, JSON.stringify({
      failed: true, error: e.message, at: new Date().toISOString(),
    }));
    process.exit(1);
  }
}

main();
