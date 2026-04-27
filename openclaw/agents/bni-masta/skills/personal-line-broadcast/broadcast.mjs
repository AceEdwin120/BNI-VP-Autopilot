#!/usr/bin/env node
// personal-line-broadcast — Pipeline #2 (Post-meeting LinePc) PLANNER.
//
// Produces the broadcast plan (target groups + 2-message payload) for delivery
// via Computer Use → LINE for Mac → the operator's personal LINE account. A Claude
// Desktop session reads this plan, drives LINE.app, and calls --mark-done
// after to record the idempotency marker.
//
// AppleScript / osascript path is intentionally abandoned — macOS Sequoia's
// TCC denies System Events keystrokes from osascript regardless of grants.
// See SKILL.md for the investigation.
//
// Usage:
//   Plan:  node broadcast.mjs <YYYY-MM-DD> <bot_id> [--force] [--dry-run]
//   Mark:  node broadcast.mjs <YYYY-MM-DD> <bot_id> --mark-done '<results-json>' [--dry-run]
//
// Plan exit codes:
//   0   plan emitted to stdout
//   1   error (missing roll_call, deck_done, etc.)
//   2   bad usage
//   10  skipped — not Friday (use --force)
//   11  skipped — test meeting (use --force)
//   12  skipped — already broadcast successfully (use --force)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.BNI_VAULT_DIR || "<vault-path>";
const SECRETS = "~/.openclaw/secrets/bni-masta.env";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS);

function isFriday(date) {
  return new Date(`${date}T12:00:00+08:00`).getUTCDay() === 5;
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

function buildMessages(date, fm, driveUrl) {
  const stats = `📊 <YourChapter> ${date} 例會總結
應到 ${fm.expected_count} / 實到 ${fm.present_count} / 全程 ${fm.present_full} / 遲到 ${fm.late_count} / 早退 ${fm.early_leave_count} / 缺席 ${fm.absent_count} / 來賓 ${fm.visitor_count} / Helper ${fm.helper_count}`;
  const lines = [stats];
  if (fm.absent_members?.length) lines.push(`❌ 缺席 (${fm.absent_count})：${fm.absent_members.join("、")}`);
  if (fm.visitors?.length)       lines.push(`👥 來賓 (${fm.visitor_count})：${fm.visitors.map(v => v.split("/")[1]?.trim() || v).join("、")}`);
  if (fm.helpers?.length)        lines.push(`🤝 Helper (${fm.helper_count})：${fm.helpers.map(v => v.split("/")[0]?.replace(/^helper[\/|｜:：\-\s]*/i, "").trim() || v).join("、")}`);

  return [
    lines.join("\n"),
    `📎 完整報告 (PDF):\n${driveUrl}`,
  ];
}

function markerPath(date, botId) {
  return join(VAULT, "raw/meetings", date, `${botId}.personal_line_done`);
}

function realPayload(date, botId) {
  const rcPath = join(VAULT, "raw/roll_calls", `${date}.md`);
  if (!existsSync(rcPath)) { console.error(`✗ no roll_call at ${rcPath}`); process.exit(1); }
  const fm = parseFM(readFileSync(rcPath, "utf8"));
  const deckMarker = join(VAULT, "raw/meetings", date, `${botId}.deck_done`);
  if (!existsSync(deckMarker)) { console.error(`✗ no deck_done marker at ${deckMarker} — run meeting-deck-report first`); process.exit(1); }
  const deck = JSON.parse(readFileSync(deckMarker, "utf8"));
  const driveUrl = deck.driveUrl;
  if (!driveUrl) { console.error(`✗ deck_done has no driveUrl`); process.exit(1); }
  return buildMessages(date, fm, driveUrl);
}

function plan(date, botId, force, dryRun) {
  if (!force && !isFriday(date)) {
    console.error(`⏭ ${date} is not a Friday — skipping (use --force to override)`);
    process.exit(10);
  }

  const meetingMd = join(VAULT, "wiki/meetings", `${date}.md`);
  if (existsSync(meetingMd)) {
    const mfm = parseFM(readFileSync(meetingMd, "utf8"));
    if (mfm.test === true && !force) {
      console.error(`⏭ ${date} marked test:true — skipping (use --force to override)`);
      process.exit(11);
    }
  }

  const mp = markerPath(date, botId);
  if (existsSync(mp) && !force) {
    try {
      const existing = JSON.parse(readFileSync(mp, "utf8"));
      const allOk = existing.done && Array.isArray(existing.results) && existing.results.length > 0
                    && existing.results.every(r => r.ok);
      if (allOk) {
        console.error(`⚠ already broadcast successfully at ${existing.at} — use --force to re-run`);
        process.exit(12);
      }
      console.error(`▸ prior run had failures or was empty — replanning`);
    } catch (_) {
      console.error(`▸ prior marker unreadable — replanning`);
    }
  }

  const mode = (process.env.BNI_PERSONAL_LINE_MODE || "test").toLowerCase();
  const productionTargets = (process.env.BNI_PERSONAL_LINE_TARGETS || "").split(",").map(s => s.trim()).filter(Boolean);
  const testTargets = (process.env.BNI_PERSONAL_LINE_TEST_TARGETS || "<YourTestGroup>").split(",").map(s => s.trim()).filter(Boolean);

  let targets, messages, payloadKind;
  if (dryRun) {
    targets = testTargets;
    messages = ["OK"];
    payloadKind = "dry-run";
  } else if (mode === "production") {
    targets = productionTargets;
    if (!targets.length) {
      console.error("✗ BNI_PERSONAL_LINE_TARGETS is empty — set it in ~/.openclaw/secrets/bni-masta.env");
      process.exit(2);
    }
    messages = realPayload(date, botId);
    payloadKind = "production";
  } else {
    targets = testTargets;
    messages = realPayload(date, botId);
    payloadKind = "test";
  }

  const out = {
    skill: "personal-line-broadcast",
    pipeline: "post-meeting-linpc",
    runtime: "computer-use",
    date,
    botId,
    mode,
    payloadKind,
    targets,
    messages,
    markerPath: mp,
    sendGapMs: Number(process.env.BNI_PERSONAL_LINE_DELAY_MS || 1500),
    instructions: [
      "Computer Use executor (Claude Desktop session):",
      "1. request_access apps=['LINE'] reason='post-meeting LinePc broadcast'",
      "2. open_application 'LINE'; screenshot to confirm frontmost",
      "3. For each target in targets[]:",
      "   a. left_click the LINE search field (top-left, '搜尋聊天和訊息')",
      "   b. select-all (cmd+a) → delete → type the target group name",
      "   c. left_click the matching chat row in the result list",
      "   d. left_click the '輸入訊息' input box at the bottom",
      "   e. For each message in messages[]: type the message → press Return → wait sendGapMs",
      "   f. screenshot to confirm both sent",
      "4. Build results: [{target, ok, error?, messages: [{idx, ok}, …]}, …]",
      "5. Persist by calling: node broadcast.mjs <date> <botId> --mark-done '<results-json>' [--dry-run]",
    ],
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(0);
}

function markDone(date, botId, resultsRaw, dryRun) {
  let results;
  try { results = JSON.parse(resultsRaw); }
  catch (e) { console.error(`✗ invalid results JSON: ${e.message}`); process.exit(2); }
  if (!Array.isArray(results)) { console.error(`✗ results must be a JSON array`); process.exit(2); }

  const path = markerPath(date, botId);
  const targets = results.map(r => r.target);
  writeFileSync(path, JSON.stringify({
    done: true,
    at: new Date().toISOString(),
    dryRun,
    targets,
    results,
  }, null, 2));

  const ok = results.filter(r => r.ok).length;
  console.error(`✓ marker written at ${path}`);
  console.error(`  ${ok}/${results.length} targets OK${dryRun ? " (dry-run)" : ""}`);
  process.exit(ok === results.length ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const botId = args.find(a => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a));
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const markIdx = args.indexOf("--mark-done");

  if (!date || !botId) {
    console.error("usage: broadcast.mjs <YYYY-MM-DD> <bot_id> [--force] [--dry-run]");
    console.error("       broadcast.mjs <YYYY-MM-DD> <bot_id> --mark-done '<results-json>' [--dry-run]");
    process.exit(2);
  }

  if (markIdx >= 0) {
    const resultsRaw = args[markIdx + 1];
    if (!resultsRaw) { console.error("✗ --mark-done requires a JSON array argument"); process.exit(2); }
    markDone(date, botId, resultsRaw, dryRun);
  } else {
    plan(date, botId, force, dryRun);
  }
}

main();
