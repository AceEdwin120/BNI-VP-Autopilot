#!/usr/bin/env node
// meeting-poll — detect Recall.ai bots that are done, fetch data, run pipeline.
//
// Runs every 60s via LaunchAgent ai.bnimasta.meeting-poll.plist.
// Idempotent: writes <bot_id>.done marker so already-processed bots are skipped.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { s2t, s2tDeep } from "../../../services/lib/s2t.mjs";

const SECRETS_ENV = join(homedir(), ".openclaw/secrets/bni-masta.env");
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

const VAULT = "<vault-path>";
const MEETINGS = join(VAULT, "raw/meetings");
const REGION = process.env.RECALL_REGION || "ap-northeast-1";
const API = `https://${REGION}.recall.ai`;
const KEY = process.env.RECALL_API_KEY;
const SKILL_DIR = join(homedir(), ".openclaw/agents/bni-masta/agent/skills");

if (!KEY) { console.error("RECALL_API_KEY not set"); process.exit(2); }
if (!existsSync(MEETINGS)) { console.log("no raw/meetings/ yet"); process.exit(0); }

async function recallGet(path) {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Token ${KEY}` } });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function downloadTo(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
}

function findBotManifests() {
  const bots = [];
  for (const date of readdirSync(MEETINGS)) {
    const dir = join(MEETINGS, date);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".bot.json")) continue;
      const botId = f.replace(".bot.json", "");
      const doneMarker = join(dir, `${botId}.done`);
      if (existsSync(doneMarker)) continue;
      bots.push({ botId, date, dir, manifestPath: join(dir, f) });
    }
  }
  return bots;
}

function runSkill(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: dirname(cmd), timeout: timeoutMs });
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.error(`  ✗ ${basename(cmd)} timed out after ${timeoutMs}ms`);
    return false;
  }
  return r.status === 0;
}

function normalizeEvents(events) {
  const out = [];
  for (const e of events) {
    const action = e.action;
    const p = e.participant || {};
    out.push({
      type: {
        join: "participant_join", leave: "participant_leave", update: "rename",
        speech_on: "speech", speech_off: "speech_end",
        webcam_on: "video_on", webcam_off: "video_off",
      }[action] || action,
      timestamp: e.timestamp?.absolute,
      participant_id: p.id ? String(p.id) : null,
      display_name: p.name || "",
      is_host: p.is_host ?? false,
    });
  }
  return out;
}

async function processBot({ botId, date, dir, manifestPath }) {
  const bot = await recallGet(`/api/v1/bot/${botId}/`);
  const changes = bot.status_changes || [];
  const last = changes[changes.length - 1];
  if (!last || last.code !== "done") {
    console.log(`  · bot ${botId} · ${last?.code || "?"}`);
    return false;
  }
  console.log(`  · bot ${botId} · done · downloading artifacts…`);
  const rec = (bot.recordings || [])[0];
  if (!rec) { console.log(`  ⚠ no recording on ${botId}`); return false; }
  const shortcuts = rec.media_shortcuts || {};
  const pe = shortcuts.participant_events?.data || {};

  // participant events (json array) → normalized jsonl
  if (pe.participant_events_download_url) {
    const tmp = join(dir, `${botId}.participant_events.json`);
    await downloadTo(pe.participant_events_download_url, tmp);
    const events = JSON.parse(readFileSync(tmp, "utf8"));
    const normalized = normalizeEvents(events);
    const jsonlPath = join(dir, "participants.jsonl");
    // Only append if not already present (de-dupe rough: append all; resolve.mjs will aggregate)
    appendFileSync(jsonlPath, normalized.map(r => JSON.stringify(r)).join("\n") + "\n");
  }
  if (pe.speaker_timeline_download_url) {
    await downloadTo(pe.speaker_timeline_download_url, join(dir, "speaker_timeline.json"));
  }
  if (pe.participants_download_url) {
    await downloadTo(pe.participants_download_url, join(dir, "participants_list.json"));
  }
  // transcript shortcut (if ready) — download, normalize 簡體→繁體, also emit transcript.jsonl
  const tr = shortcuts.transcript?.data;
  if (tr?.download_url) {
    const tjPath = join(dir, "transcript.json");
    await downloadTo(tr.download_url, tjPath);
    try {
      const raw = JSON.parse(readFileSync(tjPath, "utf8"));
      const converted = s2tDeep(raw, ["text"]);
      writeFileSync(tjPath, JSON.stringify(converted, null, 2));
      // Build a transcript.jsonl compatible with meeting-report if the recall-webhook
      // didn't already populate one from realtime transcript.data events.
      const jsonlPath = join(dir, "transcript.jsonl");
      if (!existsSync(jsonlPath) && Array.isArray(converted)) {
        const lines = converted.map(r => JSON.stringify({
          timestamp: r.timestamp?.absolute || r.timestamp || null,
          participant_id: r.participant?.id ? String(r.participant.id) : null,
          display_name: r.participant?.name || "",
          text: s2t((r.words || []).map(w => w.text || "").join(" ").trim() || r.text || ""),
          words: r.words,
        }));
        writeFileSync(jsonlPath, lines.join("\n") + "\n");
      }
    } catch (e) {
      console.log(`  [s2t/transcript.json] ${e.message}`);
    }
  }
  // If transcript.jsonl already exists from realtime webhook, also s2t-normalize it
  // (harmless on 繁體 rows — s2t short-circuits on non-simplified strings)
  const tjl = join(dir, "transcript.jsonl");
  if (existsSync(tjl)) {
    try {
      const lines = readFileSync(tjl, "utf8").split("\n").filter(Boolean);
      const normalized = lines.map(l => {
        const r = JSON.parse(l);
        if (r.text) r.text = s2t(r.text);
        return JSON.stringify(r);
      });
      writeFileSync(tjl, normalized.join("\n") + "\n");
    } catch (e) { console.log(`  [s2t/transcript.jsonl] ${e.message}`); }
  }

  // Record the meeting_end for resolve.mjs to consume
  if (rec.completed_at) {
    writeFileSync(join(dir, "_times.json"), JSON.stringify({
      meeting_start: rec.started_at,
      meeting_end: rec.completed_at,
    }, null, 2));
  }

  // Run the downstream pipeline
  console.log(`  · bot ${botId} · running resolve-attendance…`);
  const r1 = runSkill(process.execPath, [join(SKILL_DIR, "resolve-attendance/resolve.mjs"), date]);
  console.log(`  · bot ${botId} · running ingest-claude…`);
  const r2 = runSkill("/bin/bash", [join(SKILL_DIR, "ingest-claude/compile.sh"), `raw/meetings/${date}`]);
  console.log(`  · bot ${botId} · running meeting-report…`);
  const r3 = runSkill("/bin/bash", [join(SKILL_DIR, "meeting-report/report.sh"), date]);
  console.log(`  · bot ${botId} · running attendance-to-sheet…`);
  const r4 = runSkill(process.execPath, [join(SKILL_DIR, "attendance-to-sheet/update.mjs"), date]);
  // Push updated member front-matter into <YourChapter>會員名單 + 紅綠燈 tabs immediately
  // (so 紅綠燈 scores reflect this meeting without waiting for Sunday cron)
  console.log(`  · bot ${botId} · running roster-sync --push-only…`);
  const r5 = runSkill(process.execPath, [join(SKILL_DIR, "roster-sync/sync.mjs"), "--push-only"]);
  // Telegram digest to the operator — Friday-only by default; skill self-skips other days.
  // Idempotent per bot; failure does NOT block the chain (other steps already done).
  console.log(`  · bot ${botId} · running post-meeting-digest…`);
  const r6 = runSkill(process.execPath, [join(SKILL_DIR, "post-meeting-digest/digest.mjs"), date, botId]);
  // (post-meeting-line-digest disabled — superseded by meeting-deck-report below,
  //  which sends a richer stats summary + Drive PDF link in one push.)
  const r7 = true;
  // Detailed per-member report (rename history + speech log + Haiku summaries)
  // → vault md + 會議詳情 sheet row + Speech Log sheet rows. Runs every meeting.
  console.log(`  · bot ${botId} · running detailed-meeting-report…`);
  const r8 = runSkill(process.execPath, [join(SKILL_DIR, "detailed-meeting-report/detailed.mjs"), date, botId]);
  // HTML+PDF deck → Google Drive (anyone-reader) → 2 LINE messages (stats + link).
  // Friday-only by default. Depends on r8's detailed.md output.
  console.log(`  · bot ${botId} · running meeting-deck-report…`);
  const r9 = runSkill(process.execPath, [join(SKILL_DIR, "meeting-deck-report/deck.mjs"), date, botId]);
  writeFileSync(join(dir, `${botId}.done`), JSON.stringify({
    processed_at: new Date().toISOString(),
    resolve_ok: r1, ingest_ok: r2, report_ok: r3, sheet_ok: r4,
    roster_sync_ok: r5, digest_ok: r6, line_digest_ok: r7, detailed_ok: r8,
    deck_ok: r9,
  }, null, 2));
  console.log(`  · bot ${botId} · ✓`);
  return true;
}

async function main() {
  const bots = findBotManifests();
  console.log(`▸ polling ${bots.length} unfinished bots…`);
  let done = 0, active = 0, errors = 0;
  for (const b of bots) {
    try { if (await processBot(b)) done++; else active++; }
    catch (e) { errors++; console.error(`  ✗ bot ${b.botId}: ${e.message}`); }
  }
  console.log(`✓ meeting-poll tick done (${done} finalized, ${active} still active, ${errors} errors)`);
}

main();
