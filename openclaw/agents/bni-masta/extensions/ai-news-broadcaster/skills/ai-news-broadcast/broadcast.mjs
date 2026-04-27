#!/usr/bin/env node
// ai-news-broadcast — Stage 5 + Stage 6 of the AI News Broadcaster.
//
// End-to-end orchestrator. Imports `runScrape`, `runDeck`, `runArchive`,
// `runPersonalLine` from the sibling skill modules and chains them in a
// single Node process — no child process spawn, no stdout parsing. After
// the pipeline succeeds it fans out to the two LINE channels in parallel
// via `Promise.allSettled`:
//
//   8a. BNI Masta bot account   — vendored LINE Messaging API push (this file).
//   8b. Operator's personal LINE    — runPersonalLine() composes Computer Use
//                                 plan JSON in the same shape the existing
//                                 personal-line-broadcast planner emits;
//                                 Claude Desktop executor consumes it later.
//
// Lives one level deeper than the parent BNI Masta autoload root
// (extensions/ai-news-broadcaster/skills/...), so the parent agent does NOT
// auto-pick it up. Invocation is manual (this file) or scheduled (Stage 7).
//
// Usage:
//   node broadcast.mjs                                   # full pipeline, live
//   node broadcast.mjs --dry-run                         # cascade dryRun:true
//                                                       #   into all sub-skills,
//                                                       #   skip LINE push,
//                                                       #   log message body
//   node broadcast.mjs --bot-only                        # skip personal-LINE leg
//   node broadcast.mjs --personal-only                   # skip bot LINE leg
//   node broadcast.mjs --vault-root <path>               # override vault root
//   node broadcast.mjs --keep-temp                       # keep build/ on success
//   node broadcast.mjs --personal-target-groups <a,b>    # personal-LINE targets
//                                                       #   (overrides
//                                                       #    LINE_PERSONAL_TARGET_GROUPS env)
//   node broadcast.mjs --test-targets                    # Stage 7 — load
//                                                       #   ../../config/test-targets.json
//                                                       #   and override BOTH
//                                                       #   LINE_PERSONAL_TARGET_GROUPS
//                                                       #   and LINE_TARGET_GROUP_IDS for
//                                                       #   the duration of this run.
//                                                       #   Default OFF; only used in
//                                                       #   the install-time dry-run +
//                                                       #   live integration test.
//
// Exit codes:
//   0   success (or every attempted fan-out channel OK / dry-run / no-op)
//   1   fatal — a required pipeline step (scrape/deck/archive) failed,
//                OR every attempted fan-out channel failed
//   2   bad CLI usage

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { runScrape } from "../ai-news-scrape/scrape.mjs";
import { runDeck }   from "../ai-news-deck/deck.mjs";
import { runArchive } from "../ai-news-archive/archive.mjs";
import { runPersonalLine } from "./personal-line.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Paths ───────────────────────────────────────────────────────────────────
const SECRETS = process.env.BNI_SECRETS_FILE
  || "~/.openclaw/secrets/bni-masta.env";
const OPENCLAW_JSON = "~/.openclaw/openclaw.json";

// ── Tiny env loader ─────────────────────────────────────────────────────────
// Vendored from skills/post-meeting-line-digest/digest.mjs:24-30 and
// skills/meeting-deck-report/deck.mjs:19-26 (read-only; not imported per
// MANIFEST policy). Same KEY=VALUE shape; missing file is a no-op.
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const ln of readFileSync(p, "utf8").split("\n")) {
    const m = ln.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS);

// ── CLI parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    botOnly: false,
    personalOnly: false,
    dryRun: false,
    vaultRoot: null,
    keepTemp: false,
    personalTargetGroupsRaw: null,   // CLI override; falls back to env at resolve time
    testTargets: false,              // Stage 7 — see resolveTestTargets() below
    staggered: false,                // v3 — read config/schedule.json + sleep until each fire_at_taipei
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bot-only") out.botOnly = true;
    else if (a === "--personal-only") out.personalOnly = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--vault-root") out.vaultRoot = argv[++i];
    else if (a === "--keep-temp") out.keepTemp = true;
    else if (a === "--personal-target-groups") out.personalTargetGroupsRaw = argv[++i];
    else if (a === "--test-targets") out.testTargets = true;
    else if (a === "--staggered") out.staggered = true;
    else if (a === "-h" || a === "--help") { console.error(usage()); process.exit(0); }
    else {
      console.error(`✗ unknown argument: ${a}\n`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (out.botOnly && out.personalOnly) {
    console.error(`✗ --bot-only and --personal-only are mutually exclusive`);
    process.exit(2);
  }
  return out;
}

// Stage 7 — load extensions/ai-news-broadcaster/config/test-targets.json and
// return its parsed contents. Honors a BNI_AINEWS_TEST_TARGETS_FILE env
// override for unusual test layouts.
//
// Returns:
//   { personal_target_groups: string[], bot_target_group_ids: string[], path }
//
// Throws if the file is missing or malformed — callers should only invoke
// this when args.testTargets is true.
function resolveTestTargets() {
  const p = process.env.BNI_AINEWS_TEST_TARGETS_FILE
    || resolve(__dirname, "..", "..", "config", "test-targets.json");
  if (!existsSync(p)) {
    throw new Error(`--test-targets: test-targets file not found at ${p}`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new Error(`--test-targets: invalid JSON at ${p} (${e.message})`); }
  const personal = Array.isArray(raw.personal_target_groups)
    ? raw.personal_target_groups.map(s => String(s).trim()).filter(Boolean)
    : [];
  const bot = Array.isArray(raw.bot_target_group_ids)
    ? raw.bot_target_group_ids.map(s => String(s).trim()).filter(Boolean)
    : [];
  return { personal_target_groups: personal, bot_target_group_ids: bot, path: p };
}

// Load the staggered-delivery schedule (v3). Used by --staggered mode.
//   { deliveries: [{stage, fire_at_taipei, channel, group_id|display_name, name}, ...],
//     retry: { bot_push_attempts, bot_push_backoff_ms } }
function loadSchedule() {
  const p = process.env.BNI_AINEWS_SCHEDULE_FILE
    || resolve(__dirname, "..", "..", "config", "schedule.json");
  if (!existsSync(p)) {
    throw new Error(`--staggered: schedule file not found at ${p}`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { throw new Error(`--staggered: invalid JSON at ${p} (${e.message})`); }
  const deliveries = Array.isArray(raw.deliveries) ? raw.deliveries : [];
  const retry = raw.retry || { bot_push_attempts: 1, bot_push_backoff_ms: [] };
  return { deliveries, retry, path: p };
}

// Parse a Taipei wall-clock time like "09:00" → epoch ms for TODAY in Taipei.
// Used to schedule sleeps in --staggered mode.
function parseTaipeiTimeToMs(timeStr) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" })
    .format(new Date()); // "YYYY-MM-DD"
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`bad time format: ${timeStr} (expected HH:MM)`);
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  // ISO with explicit Taipei offset — Date parses unambiguously.
  return new Date(`${today}T${hh}:${mm}:00+08:00`).getTime();
}

const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms)));

// Push a single message to a SINGLE LINE group with bounded retry. Used by
// --staggered mode to handle transient LINE Messaging API failures (5xx,
// rate-limit) without losing the day's delivery.
async function pushBotToGroupWithRetry({ token, groupId, text, attempts, backoffMs }) {
  const failures = [];
  for (let i = 1; i <= attempts; i++) {
    try {
      await lineApiPush(token, groupId, text);
      return { ok: true, attempts: i };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      failures.push(msg);
      console.error(`  attempt ${i}/${attempts} failed: ${msg}`);
      if (i < attempts) {
        const wait = backoffMs[i - 1] ?? 5000;
        console.error(`  backoff ${wait}ms before retry...`);
        await sleep(wait);
      }
    }
  }
  return { ok: false, attempts, failures };
}

// Notify the operator via Telegram (BNI Masta bot, <your-telegram-alert-bot>). Used by --staggered
// mode when a stage fails after all retries — alerts the operator and STOPS the rest
// of the day's pipeline so we don't bombard partial recipients.
//
// Reads BNI_BOT_TOKEN + ALEX_TELEGRAM_ID from env (loaded from
// ~/.openclaw/secrets/bni-masta.env). Best-effort: if the alert itself fails,
// logs to stderr but does not throw — we don't want notification failures to
// mask the original stage failure.
async function notifyTelegramAlert(text) {
  const token = process.env.BNI_BOT_TOKEN;
  const chatId = process.env.ALEX_TELEGRAM_ID;
  if (!token || !chatId) {
    console.error(`[ai-news-broadcast] ⚠ telegram alert skipped — BNI_BOT_TOKEN or ALEX_TELEGRAM_ID missing`);
    return { ok: false, error: "credentials missing" };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Plain text — no parse_mode. Error strings frequently contain _, *, `,
      // [, ] which the MarkdownV2 parser rejects with "Can't find end of the
      // entity". Verified bug 2026-04-27.
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[ai-news-broadcast] ⚠ telegram HTTP ${resp.status}: ${body.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    console.error(`[ai-news-broadcast] ✓ telegram alert sent to ${chatId}`);
    return { ok: true };
  } catch (e) {
    console.error(`[ai-news-broadcast] ⚠ telegram alert failed: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  }
}

// Resolve the personal-LINE target group display names. CLI flag wins; falls
// back to the LINE_PERSONAL_TARGET_GROUPS env var. Comma-separated.
function resolvePersonalTargetGroups(cliRaw) {
  const raw = cliRaw ?? process.env.LINE_PERSONAL_TARGET_GROUPS ?? "";
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

function usage() {
  return [
    "ai-news-broadcast — orchestrator + bot LINE + personal LINE (Stage 6)",
    "",
    "Usage:",
    "  node broadcast.mjs [--bot-only] [--personal-only] [--dry-run]",
    "                     [--vault-root <path>] [--keep-temp]",
    "                     [--personal-target-groups <name1,name2,...>]",
    "                     [--test-targets] [--staggered]",
    "",
    "  --test-targets   Stage 7 — overrides BOTH personal-LINE display names",
    "                   and bot-LINE group IDs from",
    "                   ../../config/test-targets.json (overrides env). Used",
    "                   for the install-time dry-run + live integration test.",
    "",
    "Env (loaded from ~/.openclaw/secrets/bni-masta.env):",
    "  APIFY_TOKEN                  required for live runs (scrape stage)",
    "  OPENROUTER_API_KEY           preferred for live runs (deck stage; BNI Masta convention)",
    "  ANTHROPIC_API_KEY            fallback for live runs (deck stage; only used if OPENROUTER_API_KEY absent)",
    "  LINE_CHANNEL_ACCESS_TOKEN    required for live bot LINE push (Stage 5)",
    "  LINE_TARGET_GROUP_IDS        comma-separated LINE group IDs",
    "                                 e.g. 'C1234...,C5678...' — bot fan-out",
    "  LINE_PERSONAL_TARGET_GROUPS  comma-separated LINE group display names",
    "                                 (Stage 6) — personal-LINE fan-out;",
    "                                 e.g. '<YourChapter> 學員交流, BNI 副主席群'",
    "  BNI_VAULT_ROOT               vault root path (preferred)",
    "  BNI_VAULT_DIR                vault root path (fallback, scrape.mjs key)",
    "  BNI_SECRETS_FILE             override secrets file path",
    "",
    "See ../../MANIFEST.md and ./SKILL.md for the full contract.",
  ].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function taipeiNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}${parts.minute}`,
  };
}

function resolveVaultRoot(argFlag) {
  if (argFlag) return resolve(argFlag);
  if (process.env.BNI_VAULT_ROOT) return resolve(process.env.BNI_VAULT_ROOT);
  if (process.env.BNI_VAULT_DIR)  return resolve(process.env.BNI_VAULT_DIR);
  // Convention path used by scrape.mjs / archive.mjs
  const scrapeDefault = "<vault-path>";
  if (existsSync(scrapeDefault)) return scrapeDefault;
  // Last-ditch fallback — synthesize a tmp tree on dev machines that don't
  // have the production vault.
  return join(homedir(), ".tmp", "bni-vault");
}

// ── Vendored LINE bot push ──────────────────────────────────────────────────
// Vendored from skills/post-meeting-line-digest/digest.mjs (read-only;
// not imported per MANIFEST policy). Replicates two pieces of that file:
//   - getLineToken()                 — env-then-openclaw.json fallback (lines 34-41)
//   - sendLine() POST pattern        — fetch to /v2/bot/message/push  (lines 172-189)
// We keep the pattern independent so a fix in either file does not have to
// ripple. If the LINE Messaging API endpoint or auth header changes, both
// vendored copies need the same edit. See MANIFEST §5.2.
function getLineToken() {
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
    return cfg.channels?.line?.channelAccessToken || null;
  } catch { return null; }
}

async function lineApiPush(token, toId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: toId,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`LINE ${r.status}: ${txt}`);
  }
  return r.json();
}

// Resolve a human-readable source label for a curated item. The LLM only
// returns id/headline/summary/why/url/posted_at/tier — author/page-handle
// must come from the scrape posts (by id) or sources.json (by source_id).
function sourceLabelForItem(item, postsById, sourcesById) {
  const post = postsById[item.id];
  if (post) {
    if (post.author) return String(post.author).trim();
    const src = sourcesById[post.source_id];
    if (src && (src.name_zhTW || src.page_handle)) {
      return String(src.name_zhTW || src.page_handle).trim();
    }
    if (post.source_id) return String(post.source_id).trim();
  }
  if (item.source_url) {
    const m = String(item.source_url).match(/facebook\.com\/([^/?#]+)/);
    if (m) return m[1];
  }
  return "(來源不明)";
}

function composeBotLineMessage({ curated, deckUrl, runDate, postsById, sourcesById }) {
  const items = (curated.items || []).slice(0, 3);
  const tips  = (curated.tips_zhTW || []).slice(0, 3);
  const cta   = String(curated.cta_zhTW || "").trim();
  const dateLabel = `${runDate.slice(0, 4)}/${runDate.slice(5, 7)}/${runDate.slice(8, 10)}`;
  const circle = ["①", "②", "③"];

  const itemBlocks = items.map((it, i) => {
    const head    = String(it.headline_zhTW || "(無標題)").trim();
    const summary = String(it.summary_zhTW || "").trim();
    const why     = String(it.why_it_matters_zhTW || "").trim();
    const src     = sourceLabelForItem(it, postsById, sourcesById);
    const url     = String(it.source_url || "").trim();
    const block = [
      `${circle[i] || `(${i + 1})`} ${head} — ${src}`,
    ];
    if (summary) block.push(summary);
    if (why)     block.push(`👉 ${why}`);
    if (url)     block.push(`🔗 ${url}`);
    return block.join("\n");
  });
  const tipsLines = tips.map((t, i) => `${i + 1}. ${String(t).trim()}`);

  const lines = [];
  lines.push(`📰 AI 趨勢快訊 — ${dateLabel}`);
  lines.push("");
  lines.push(itemBlocks.join("\n\n"));
  lines.push("");
  lines.push(`完整簡報 PDF：${deckUrl}`);
  lines.push("");
  lines.push("💡 給各位夥伴建議：");
  lines.push(...tipsLines);
  if (cta) {
    lines.push("");
    lines.push("🗣️ 互動：");
    lines.push(cta);
  }
  return lines.join("\n");
}

async function pushBotLine(curated, deckUrl, { runDate, postsById, sourcesById, dryRun }) {
  const text = composeBotLineMessage({ curated, deckUrl, runDate, postsById, sourcesById });

  const groupIdsRaw = process.env.LINE_TARGET_GROUP_IDS || "";
  const groupIds = groupIdsRaw.split(",").map(s => s.trim()).filter(Boolean);

  if (dryRun) {
    console.log(`[ai-news-broadcast] bot LINE dry-run — would push to ${groupIds.length} group(s):`);
    for (const g of groupIds) console.log(`  • ${g}`);
    if (groupIds.length === 0) {
      console.log(`  (no targets configured — set LINE_TARGET_GROUP_IDS for live runs)`);
    }
    console.log(`---- LINE message body (${text.length} chars) ----`);
    console.log(text);
    console.log(`---- end message body ----`);
    return { dryRun: true, ok: 0, failed: [], targets: groupIds.length, groupIds, text };
  }

  const token = getLineToken();
  if (!token) {
    return {
      ok: 0, failed: [["(no targets attempted)", "LINE_CHANNEL_ACCESS_TOKEN missing"]],
      targets: groupIds.length, text,
      error: "LINE_CHANNEL_ACCESS_TOKEN missing",
    };
  }
  if (groupIds.length === 0) {
    console.log(`[ai-news-broadcast] bot LINE: LINE_TARGET_GROUP_IDS empty — nothing to push`);
    return { ok: 0, failed: [], targets: 0, text, noop: true };
  }

  const settled = await Promise.allSettled(groupIds.map(g => lineApiPush(token, g, text)));
  const failed = [];
  let ok = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok += 1;
    else failed.push([groupIds[i], (r.reason && r.reason.message) || String(r.reason)]);
  });
  return { ok, failed, targets: groupIds.length, text };
}

// ── Personal LINE (Stage 6 — Path A) ────────────────────────────────────────
// The personal-LINE channel composes its own Computer Use plan JSON in the
// SAME shape that skills/personal-line-broadcast/broadcast.mjs emits — so the
// existing Claude Desktop executor consumes both broadcasts identically. We
// do NOT spawn the existing planner (it is meeting-data-bound and would not
// produce our news payload). See personal-line.mjs header + MANIFEST §6.3.4
// for the full design rationale.

// ── Result classification for exit-code logic ───────────────────────────────
//
// The personal channel returns { ok: bool, ... } from runPersonalLine; the
// bot channel returns the older { ok: <count>, targets, failed, ... } shape
// from pushBotLine. isChannelOk handles both.
function isChannelOk(r) {
  if (!r) return false;
  if (r.skipped) return null;        // not attempted — neutral
  if (r.dryRun)  return true;        // dry-run logged successfully
  if (r.error)   return false;
  // personal-LINE shape: ok is a boolean (true/false)
  if (typeof r.ok === "boolean") return r.ok;
  // bot-LINE shape: ok is a fulfilled-target count
  if (r.ok > 0) return true;
  if (r.targets === 0) return true;  // no targets configured = no failure
  return false;                      // attempted real push, ok=0 — failed
}

function fmtBot(r) {
  if (!r) return "(unknown)";
  if (r.skipped) return "skipped (--personal-only)";
  if (r.dryRun) {
    const ids = (r.groupIds && r.groupIds.length)
      ? `: ${r.groupIds.join(", ")}`
      : ": none configured";
    return `dry-run (${r.targets} groups${ids})`;
  }
  if (r.error)   return `error: ${r.error}`;
  if (r.targets === 0) return "no targets configured (LINE_TARGET_GROUP_IDS empty)";
  const tail = r.failed.length ? `, failed: ${r.failed.map(f => f[0]).join(",")}` : "";
  return `pushed to ${r.ok}/${r.targets} groups${tail}`;
}

function fmtPersonal(r) {
  if (!r) return "(unknown)";
  if (r.skipped) return "skipped (--bot-only)";
  // runPersonalLine sets a `summary` string on every return shape.
  if (r.summary) return r.summary;
  if (r.error)   return `error: ${r.error}`;
  if (r.ok === true)  return "ok";
  if (r.ok === false) return "failed";
  return "(unknown)";
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const vaultRoot = resolveVaultRoot(args.vaultRoot);
  const { date: nowDate, hhmm: nowHhmm } = taipeiNow();
  const runId = `${nowDate.replace(/-/g, "")}_${nowHhmm}`;

  const dayDir = join(vaultRoot, "raw", "ai_news", nowDate);
  mkdirSync(dayDir, { recursive: true });
  const scrapeOut = join(dayDir, `${nowHhmm}_scrape.json`);
  const buildDir = join(vaultRoot, "build", "ai_news", runId);
  mkdirSync(buildDir, { recursive: true });

  // Stage 7 — `--test-targets` loads ../../config/test-targets.json and
  // overrides BOTH personal-LINE display names and bot-LINE group IDs for the
  // duration of this run. Personal-LINE override flows through the existing
  // CLI fallback (if --personal-target-groups was already supplied, it wins).
  // Bot-LINE override is implemented by mutating process.env.LINE_TARGET_GROUP_IDS
  // before pushBotLine() reads it (pushBotLine intentionally reads env at call
  // time so the override is visible).
  let testTargetsConfig = null;
  if (args.testTargets) {
    testTargetsConfig = resolveTestTargets();
    if (args.personalTargetGroupsRaw == null && testTargetsConfig.personal_target_groups.length) {
      args.personalTargetGroupsRaw = testTargetsConfig.personal_target_groups.join(",");
    }
    // Override bot-side env var iff caller did not set it explicitly via env.
    // (We always overwrite — test-targets is opt-in via the flag, so the
    // intent is "use this list for this run".)
    process.env.LINE_TARGET_GROUP_IDS = testTargetsConfig.bot_target_group_ids.join(",");
    console.log(`[ai-news-broadcast] --test-targets active — loaded ${testTargetsConfig.path}`);
    console.log(`  personal_target_groups: ${
      testTargetsConfig.personal_target_groups.length
        ? testTargetsConfig.personal_target_groups.join(", ")
        : "(empty)"
    }`);
    console.log(`  bot_target_group_ids:   ${
      testTargetsConfig.bot_target_group_ids.length
        ? testTargetsConfig.bot_target_group_ids.join(", ")
        : "(empty — bot-LINE leg will no-op)"
    }`);
  }

  const personalTargetGroups = resolvePersonalTargetGroups(args.personalTargetGroupsRaw);

  console.log(`[ai-news-broadcast] starting run_id=${runId}`);
  console.log(`  vault-root: ${vaultRoot}`);
  console.log(`  dry-run:    ${args.dryRun}`);
  console.log(`  bot-only:   ${args.botOnly}`);
  console.log(`  personal-only: ${args.personalOnly}`);
  console.log(`  test-targets:  ${args.testTargets}`);
  console.log(`  personal-target-groups: ${personalTargetGroups.length
                ? personalTargetGroups.join(", ")
                : "(none — set LINE_PERSONAL_TARGET_GROUPS or --personal-target-groups)"}`);

  // ── Step 1: SCRAPE ──
  console.log(`\n[ai-news-broadcast] step 1/4: scrape`);
  const scrapeResult = await runScrape({
    dryRun: args.dryRun,
    out: scrapeOut,
    vaultRoot,
  });
  console.log(`  ${scrapeResult.summary}`);

  // ── Step 2: DECK ──
  console.log(`\n[ai-news-broadcast] step 2/4: deck`);
  const deckResult = await runDeck({
    input: scrapeResult.outputPath,
    outDir: buildDir,
    dryRun: args.dryRun,
  });
  console.log(`  ${deckResult.summary}`);

  // ── Step 3: ARCHIVE ──
  console.log(`\n[ai-news-broadcast] step 3/4: archive`);
  // Seam: in --dry-run, deck.mjs skips PDF rendering (no Chrome required), so
  // deck.pdf does NOT exist but deck.html does. archive.mjs requires --deck
  // to point to an existing file, but in dry-run mode it never reads the
  // bytes. Pass deck.html as a stand-in so runArchive can compose markdown
  // without erroring. (See SKILL.md.)
  const archiveDeckArg = deckResult.renderedPdf ? deckResult.pdfPath : deckResult.htmlPath;
  const archiveResult = await runArchive({
    scrape: scrapeResult.outputPath,
    curated: deckResult.curatedPath,
    deck: archiveDeckArg,
    vaultRoot,
    dryRun: args.dryRun,
  });
  console.log(`  ${archiveResult.summary}`);

  // ── Step 4: LINE FAN-OUT ──
  console.log(`\n[ai-news-broadcast] step 4/4: LINE fan-out${args.staggered ? " (staggered mode)" : " (parallel mode)"}`);

  // Build lookup tables for the bot LINE message composer.
  const scrape = JSON.parse(readFileSync(scrapeResult.outputPath, "utf8"));
  const postsById = Object.fromEntries((scrape.posts || []).map(p => [p.id, p]));
  let sourcesById = {};
  try {
    const sp = process.env.BNI_AINEWS_SOURCES_FILE
      || resolve(__dirname, "..", "..", "config", "sources.json");
    const raw = JSON.parse(readFileSync(sp, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.sources || []);
    for (const s of arr) sourcesById[s.id] = s;
  } catch { /* tier defaults are fine */ }

  // For v1 the deck URL is a literal placeholder (Drive upload is v1.1 — see
  // plan.md §5.2 and the Stage 5 spec note in the prompt).
  const deckUrl = "詳見今日 archive";
  const runDate = scrapeResult.runDate || nowDate;

  let botResult = { skipped: true };
  let personalResult = { skipped: true };

  // ── Staggered mode (v3) ──────────────────────────────────────────────────
  // Reads config/schedule.json and processes each delivery in order, sleeping
  // until each fire_at_taipei wall-clock time. Bot stages push to ONE specific
  // group per stage with bounded retry. CU stages write the personal-line plan
  // (Claude Desktop scheduled task picks it up later). On any stage failure
  // after retries → Telegram alert to the operator + STOP the day's pipeline.
  if (args.staggered) {
    const schedule = loadSchedule();
    console.log(`[ai-news-broadcast] schedule loaded: ${schedule.deliveries.length} stage(s) from ${schedule.path}`);

    const text = composeBotLineMessage({ curated: deckResult.curated, deckUrl, runDate, postsById, sourcesById });
    const token = getLineToken();
    const stageResults = [];
    let halted = false;
    let haltReason = null;

    for (const d of schedule.deliveries) {
      if (halted) {
        stageResults.push({ ...d, status: "skipped", reason: haltReason });
        continue;
      }

      const fireMs = parseTaipeiTimeToMs(d.fire_at_taipei);
      const delayMs = fireMs - Date.now();
      const niceTime = d.fire_at_taipei;
      if (delayMs > 0) {
        const secs = Math.round(delayMs / 1000);
        console.log(`\n[stage ${d.stage}] ${niceTime} ${d.channel} → ${d.name || d.display_name}: sleeping ${secs}s until fire_at...`);
        await sleep(delayMs);
      } else {
        console.log(`\n[stage ${d.stage}] ${niceTime} ${d.channel} → ${d.name || d.display_name}: fire_at already passed (${Math.abs(Math.round(delayMs / 1000))}s ago) — firing immediately`);
      }

      if (d.channel === "bot") {
        if (args.dryRun) {
          console.log(`[stage ${d.stage}] dry-run — would push to ${d.group_id} (${d.name})`);
          stageResults.push({ ...d, status: "dry-run" });
          continue;
        }
        if (!token) {
          haltReason = `bot stage ${d.stage} cannot fire — LINE_CHANNEL_ACCESS_TOKEN missing`;
          halted = true;
          stageResults.push({ ...d, status: "failed", error: "no token" });
          await notifyTelegramAlert(
            `AI News Broadcaster — Stage ${d.stage} failed\n\n` +
            `Target: ${d.name}\n` +
            `Reason: LINE_CHANNEL_ACCESS_TOKEN missing\n\n` +
            `Remaining stages stopped. Check ~/.openclaw/secrets/bni-masta.env.`
          );
          continue;
        }
        const r = await pushBotToGroupWithRetry({
          token, groupId: d.group_id, text,
          attempts: schedule.retry.bot_push_attempts || 3,
          backoffMs: schedule.retry.bot_push_backoff_ms || [2000, 8000, 30000],
        });
        if (r.ok) {
          console.log(`[stage ${d.stage}] ✓ pushed to ${d.name} (attempt ${r.attempts})`);
          stageResults.push({ ...d, status: "ok", attempts: r.attempts });
        } else {
          console.error(`[stage ${d.stage}] ✗ failed after ${r.attempts} attempts`);
          stageResults.push({ ...d, status: "failed", attempts: r.attempts, errors: r.failures });
          haltReason = `stage ${d.stage} (${d.name}) failed after ${r.attempts} retries`;
          halted = true;
          const lastErr = (r.failures && r.failures[r.failures.length - 1]) || "unknown";
          // Plain-text Telegram (no Markdown) — error strings often contain
          // _, *, ` that break Telegram's MarkdownV2 parser. Verified bug
          // 2026-04-27 morning when LINE 429 JSON inlined into Markdown
          // produced "Can't find end of the entity starting at byte offset N".
          await notifyTelegramAlert(
            `AI News Broadcaster — Stage ${d.stage} failed\n\n` +
            `Target: ${d.name} (${d.group_id})\n` +
            `Channel: bot LINE Messaging API\n` +
            `Attempts: ${r.attempts}\n` +
            `Last error: ${String(lastErr).slice(0, 200)}\n\n` +
            `Today's remaining stages stopped (no partial delivery). ` +
            `Check LINE bot token + group membership; tomorrow 09:00 will retry.\n\n` +
            `run_id: ${runId}`
          );
        }
      } else if (d.channel === "cu") {
        // CU stage: write the personal-line plan now; the Anthropic scheduled
        // task `ai-news-cu-primary` (cron `5 9 * * *`, dispatched ~09:13) picks
        // it up and delivers via Claude Desktop Computer Use. Supports either
        // a single target (`display_name`) or an ordered array (`display_names`)
        // — v3.2 (2026-04-27) added the array form so <YourChapterMainGroup> + <YourCommunityGroup> can share
        // one plan + one scheduled task instead of needing separate plans.
        const cuTargets = Array.isArray(d.display_names) && d.display_names.length
          ? d.display_names.slice()
          : (d.display_name ? [d.display_name] : []);
        const cuLabel = cuTargets.join(" → ");
        try {
          const pr = await runPersonalLine({
            curated:      deckResult.curated,
            deckUrl,
            deckPath:     deckResult.renderedPdf ? deckResult.pdfPath : deckResult.htmlPath,
            archiveUrl:   archiveResult.mdPath || null,
            runDate,
            runId,
            vaultRoot,
            targetGroups: cuTargets,
            postsById,
            sourcesById,
            dryRun:       args.dryRun,
          });
          if (pr.ok || pr.dryRun) {
            console.log(`[stage ${d.stage}] ✓ personal-line plan written for ${cuTargets.length} target(s): ${cuLabel}`);
            stageResults.push({ ...d, status: "plan_written", targets: cuTargets });
            personalResult = pr;
          } else {
            console.error(`[stage ${d.stage}] ✗ plan write failed: ${pr.summary || pr.error || "?"}`);
            stageResults.push({ ...d, status: "failed", error: pr.summary || pr.error });
            haltReason = `stage ${d.stage} CU plan write failed`;
            halted = true;
            // Plain-text Telegram alert — no Markdown to dodge parse errors on
            // user-supplied error strings (LINE JSON contains _ and " etc.).
            await notifyTelegramAlert(
              `AI News Broadcaster — Stage ${d.stage} (CU) plan-write failed\n\n` +
              `Targets: ${cuLabel}\n` +
              `Error: ${pr.error || pr.summary || "unknown"}\n` +
              `run_id: ${runId}\n\n` +
              `Today's remaining stages stopped to avoid partial delivery.`
            );
          }
        } catch (e) {
          console.error(`[stage ${d.stage}] ✗ exception: ${e.message || e}`);
          stageResults.push({ ...d, status: "failed", error: e.message || String(e) });
          haltReason = `stage ${d.stage} exception: ${e.message || e}`;
          halted = true;
          await notifyTelegramAlert(
            `AI News Broadcaster — Stage ${d.stage} exception\n\n` +
            `${e.message || e}\n\n` +
            `run_id: ${runId}`
          );
        }
      } else {
        console.error(`[stage ${d.stage}] ⚠ unknown channel "${d.channel}" — skipping`);
        stageResults.push({ ...d, status: "skipped", reason: "unknown channel" });
      }
    }

    // Synthesize legacy-shape results for the existing summary printer.
    const botStages = stageResults.filter(s => s.channel === "bot");
    const cuStages  = stageResults.filter(s => s.channel === "cu");
    botResult = {
      ok: botStages.filter(s => s.status === "ok").length,
      targets: botStages.length,
      failed: botStages.filter(s => s.status === "failed").map(s => [s.group_id, s.errors?.[s.errors.length - 1] || s.error || "?"]),
      stageResults: botStages,
      text,
    };
    if (cuStages.length === 0) personalResult = { skipped: true };
    // (personalResult already set above for the cu stage)
    args._staggeredHalted = halted;
    args._staggeredStageResults = stageResults;

    // Skip the legacy parallel fan-out below.
  } else {
    if (!args.personalOnly) {
      tasks.push(
        pushBotLine(deckResult.curated, deckUrl, {
          runDate, postsById, sourcesById, dryRun: args.dryRun,
        })
          .then(r => { botResult = r; })
          .catch(e => {
            botResult = {
              ok: 0, failed: [["(error)", e.message || String(e)]],
              targets: 0, error: e.message || String(e),
            };
          })
      );
    }
    if (!args.botOnly) {
      tasks.push(
        runPersonalLine({
          curated:      deckResult.curated,
          deckUrl,
          deckPath:     deckResult.renderedPdf ? deckResult.pdfPath : deckResult.htmlPath,
          archiveUrl:   archiveResult.mdPath || null,
          runDate,
          runId,
          vaultRoot,
          targetGroups: personalTargetGroups,
          postsById,
          sourcesById,
          dryRun:       args.dryRun,
        })
          .then(r => { personalResult = r; })
          .catch(e => {
            personalResult = {
              ok: false,
              error: e.message || String(e),
              summary: `personal-line: error — ${e.message || String(e)}`,
            };
          })
      );
    }
    await Promise.allSettled(tasks);
  }

  // ── Cleanup ──
  if (!args.keepTemp && !args.dryRun) {
    try {
      rmSync(buildDir, { recursive: true, force: true });
      console.log(`[ai-news-broadcast] cleaned up ${buildDir}`);
    } catch (e) {
      console.error(`⚠ failed to clean ${buildDir}: ${e.message}`);
    }
  }

  // ── Summary ──
  const itemCount = (deckResult.curated?.items || []).length;
  const deckLine = deckResult.renderedPdf
    ? `${deckResult.pdfPath} (${deckResult.pages} pages)`
    : `(html only — dry-run, ${deckResult.pages} pages projected)`;
  const archiveLine = archiveResult.dryRun
    ? "(dry-run — composed in memory, not written)"
    : (archiveResult.mdPath || "(unknown)");

  const summary = [
    `[ai-news-broadcast] DONE — run_id: ${runId}`,
    `  scrape: ${scrapeResult.postsCount} posts from ${scrapeResult.sourcesCount} sources`,
    `  deck: ${deckLine}`,
    `  archive: ${archiveLine}`,
    `  bot LINE: ${fmtBot(botResult)}`,
    `  personal LINE: ${fmtPersonal(personalResult)}`,
  ].join("\n");
  console.log(`\n${summary}`);

  // ── Exit code ──
  const checks = [];
  if (!args.personalOnly) checks.push(isChannelOk(botResult));
  if (!args.botOnly)      checks.push(isChannelOk(personalResult));
  const real = checks.filter(v => v !== null);
  if (real.length > 0 && real.every(v => v === false)) {
    console.error(`✗ all attempted LINE channels failed`);
    process.exit(1);
  }

  // Touch itemCount so unused-var lint stays quiet on dev machines.
  void itemCount;
}

// Only run main() when invoked directly (node broadcast.mjs ...). Imports
// from sibling skills do NOT auto-run their CLIs thanks to the same guard
// pattern in scrape.mjs / deck.mjs / archive.mjs.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(`✗ ${e.stack || e.message || e}`);
    process.exit(1);
  });
}
