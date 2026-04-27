// personal-line.mjs — Stage 6 of the AI News Broadcaster.
//
// Personal-LINE channel (8b in plan §4). PATH A (approved 2026-04-26):
// this module DOES NOT spawn skills/personal-line-broadcast/broadcast.mjs.
// The existing meeting planner is meeting-data-bound and would not produce
// our news payload. Instead we emit the SAME JSON contract that planner
// emits (schema reverse-engineered from skills/personal-line-broadcast/
// broadcast.mjs lines 152-178) so the existing Claude Desktop Computer Use
// executor consumes both broadcasts identically — no executor changes
// required. See plan.md §5.5 and MANIFEST.md Stage 6 entry.
//
// What we produce on a live (non-dry-run) call:
//   <vault>/raw/ai_news/<date>/<run_id>.personal_line_plan.json
//
// JSON shape (1:1 with personal-line-broadcast except botId → runId, and our
// values for skill / pipeline / markerPath / messages):
//   {
//     skill:        "ai-news-broadcast",
//     pipeline:     "ai-news-broadcast",
//     runtime:      "computer-use",
//     date:         "YYYY-MM-DD",
//     runId:        "YYYYMMDD_HHMM",
//     mode:         "test" | "production",
//     payloadKind:  "dry-run" | "test" | "production",
//     targets:      [<LINE group display name>, ...],
//     messages:     [<繁中 string>],
//     markerPath:   "<vault>/raw/ai_news/<date>/<run_id>.personal_line_done",
//     sendGapMs:    1500,
//     instructions: [<Computer Use steps>],
//   }
//
// On dryRun:true we skip writing the JSON — the function just logs the
// composed message + targets and returns. The orchestrator wraps this call
// in Promise.allSettled, so a failure here NEVER aborts the bot LINE leg.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────
//
// Mirrors broadcast.mjs sourceLabelForItem so the bot and personal channels
// resolve attribution labels identically. (Copy-pasted, not imported, because
// broadcast.mjs imports US — pulling the helper out of broadcast.mjs into a
// shared file is a future refactor, not Stage 6.)
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

// Compose the 繁中 message body for the personal-LINE channel.
//
// Same content as the bot LINE message (broadcast.mjs composeBotLineMessage)
// — three headlines, three tips, one PDF placeholder line. Tuned for personal
// delivery: a softer header, a personal-voice lead-in, and gentler tip
// framing. (See SKILL.md §"Personal-LINE channel — tone" and Stage 6 brief.)
function composePersonalLineMessage({ curated, deckUrl, runDate, postsById, sourcesById }) {
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
  const countLabel = items.length === 1 ? "一則" : items.length === 2 ? "兩則" : items.length === 3 ? "三則" : `${items.length} 則`;

  const lines = [];
  lines.push(`📰 AI 趨勢快訊（${dateLabel}）`);
  lines.push("");
  lines.push(`這兩天值得知道的 ${countLabel} AI 新聞：`);
  lines.push("");
  lines.push(itemBlocks.join("\n\n"));
  lines.push("");
  lines.push(`完整簡報：${deckUrl}`);
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

// ── Public API ─────────────────────────────────────────────────────────────
//
// runPersonalLine(opts) — orchestrator-only; not exposed via CLI.
//
// opts:
//   curated       — required — { items: [...], tips_zhTW: [...] }
//                                 (deckResult.curated from runDeck())
//   targetGroups  — required — string[] of LINE group display names; if empty
//                              we no-op with summary "no targets configured"
//   runDate       — required — "YYYY-MM-DD" (Taipei timezone)
//   runId         — required — "YYYYMMDD_HHMM" — namespace for plan + marker
//   vaultRoot     — required — vault root absolute path
//   deckPath      — optional — local PDF path; logged only, not in message
//   deckUrl       — optional — placeholder URL inserted into message body
//                              (v1: "詳見今日 archive"; v1.1: real Drive URL)
//   archiveUrl    — optional — archive .md path; logged only for v1
//   postsById     — optional — { id: post } for source-label resolution
//   sourcesById   — optional — { id: source } for source-label resolution
//   dryRun        — optional — bool; skip writing the plan JSON, log only
//   sendGapMs     — optional — between-message delay (default 1500)
//
// Returns:
//   {
//     ok:              bool,
//     plannerJsonPath: string | null,
//     message:         string,
//     targetGroups:    string[],
//     summary:         string,                  // human-readable status line
//     plan?:           object,                  // the JSON we wrote / would write
//     dryRun?:         bool,                    // present iff opts.dryRun
//     noop?:           bool,                    // present iff targetGroups empty
//   }
//
// Failure mode: never throws. Returns ok:false with a `summary` field that
// the orchestrator surfaces in its block. The bot LINE leg runs in parallel
// and is unaffected.
export async function runPersonalLine(opts = {}) {
  const {
    curated,
    targetGroups = [],
    runDate,
    runId,
    vaultRoot,
    deckUrl = "詳見今日 archive",
    deckPath,
    archiveUrl,
    postsById = {},
    sourcesById = {},
    dryRun = false,
    sendGapMs,
  } = opts;

  // ── Sanity checks (caller-side; we don't process.exit) ───────────────────
  if (!curated || !Array.isArray(curated.items)) {
    return {
      ok: false,
      plannerJsonPath: null,
      message: "",
      targetGroups,
      summary: "personal-line: curated.items missing — skipped",
    };
  }
  if (!runDate || !runId || !vaultRoot) {
    return {
      ok: false,
      plannerJsonPath: null,
      message: "",
      targetGroups,
      summary: "personal-line: runDate / runId / vaultRoot required — skipped",
    };
  }

  // ── Compose message body ──────────────────────────────────────────────────
  const message = composePersonalLineMessage({
    curated, deckUrl, runDate, postsById, sourcesById,
  });

  // ── Mode resolution (matches existing personal-line-broadcast) ────────────
  const mode = (process.env.BNI_AINEWS_PERSONAL_MODE
                || process.env.BNI_AINEWS_MODE
                || "test").toLowerCase();
  const payloadKind = dryRun
    ? "dry-run"
    : (mode === "production" ? "production" : "test");

  // ── Build paths (our namespace, not raw/meetings/...) ─────────────────────
  const dayDir          = join(vaultRoot, "raw", "ai_news", runDate);
  const plannerJsonPath = join(dayDir, `${runId}.personal_line_plan.json`);
  const markerPath      = join(dayDir, `${runId}.personal_line_done`);

  // ── Build the plan JSON ───────────────────────────────────────────────────
  const plan = {
    skill:    "ai-news-broadcast",
    pipeline: "ai-news-broadcast",
    runtime:  "computer-use",
    date:     runDate,
    runId,
    mode,
    payloadKind,
    targets:  targetGroups,
    messages: [message],
    markerPath,
    sendGapMs: Number(
      sendGapMs
        || process.env.BNI_AINEWS_PERSONAL_DELAY_MS
        || process.env.BNI_PERSONAL_LINE_DELAY_MS  // fallback to meeting key
        || 1500
    ),
    instructions: [
      "Computer Use executor (Claude Desktop session):",
      "1. request_access apps=['LINE'] reason='ai-news-broadcast personal-LINE delivery'",
      "2. open_application 'LINE'; screenshot to confirm frontmost",
      "3. For each target in targets[]:",
      "   a. left_click the LINE search field (top-left, '搜尋聊天和訊息')",
      "   b. select-all (cmd+a) → delete → type the target group name",
      "   c. left_click the matching chat row in the result list",
      "   d. left_click the '輸入訊息' input box at the bottom",
      "   e. For each message in messages[]: type the message → press Return → wait sendGapMs",
      "   f. screenshot to confirm sent",
      "4. Build results: [{target, ok, error?, messages: [{idx, ok}, ...]}, ...]",
      `5. Persist results JSON to markerPath: ${markerPath}`,
      "   (Same convention as the meeting personal-LINE channel; the orchestrator's",
      "    idempotency check on re-runs reads this marker.)",
    ],
  };

  // Stash optional context (deckPath / archiveUrl) at the bottom of the plan
  // for the executor / human reader to see — does not affect the schema's
  // required keys above.
  if (deckPath)    plan.deckPath    = deckPath;
  if (archiveUrl)  plan.archiveUrl  = archiveUrl;

  // ── Empty-targets noop (matches bot LINE behavior) ───────────────────────
  // The orchestrator's isChannelOk treats targets==0 as neutral so a missing
  // LINE_PERSONAL_TARGET_GROUPS does not abort the run.
  if (targetGroups.length === 0) {
    if (dryRun) {
      console.log(`[personal-line] dry-run — no target groups configured (set LINE_PERSONAL_TARGET_GROUPS or --personal-target-groups)`);
      console.log(`---- personal-LINE message body (${message.length} chars) ----`);
      console.log(message);
      console.log(`---- end message body ----`);
    } else {
      console.log(`[personal-line] no target groups configured — nothing to plan`);
    }
    return {
      ok:              true,
      noop:            true,
      dryRun:          dryRun || undefined,
      plannerJsonPath: null,
      message,
      targetGroups:    [],
      plan,
      summary:         dryRun
        ? "dry-run (0 groups: none configured)"
        : "no targets configured (LINE_PERSONAL_TARGET_GROUPS empty)",
    };
  }

  // ── Dry-run: log only, do not write ──────────────────────────────────────
  if (dryRun) {
    console.log(`[personal-line] dry-run — would write plan to ${plannerJsonPath}`);
    console.log(`[personal-line] targets (${targetGroups.length}): ${targetGroups.join(", ")}`);
    console.log(`---- personal-LINE message body (${message.length} chars) ----`);
    console.log(message);
    console.log(`---- end message body ----`);
    return {
      ok:              true,
      dryRun:          true,
      plannerJsonPath: null,
      message,
      targetGroups,
      plan,
      summary:         `dry-run (${targetGroups.length} groups: ${targetGroups.join(", ")})`,
    };
  }

  // ── Live: write the plan JSON for the executor to pick up ────────────────
  try {
    mkdirSync(dirname(plannerJsonPath), { recursive: true });
    writeFileSync(plannerJsonPath, JSON.stringify(plan, null, 2) + "\n");
  } catch (e) {
    return {
      ok:              false,
      plannerJsonPath: null,
      message,
      targetGroups,
      plan,
      summary:         `personal-line: write failed — ${e.message || String(e)}`,
    };
  }

  // Log line uses the exact phrasing from the Stage 6 brief.
  console.log(`[personal-line] planner OK — executor JSON at ${plannerJsonPath}; executor will pick up next time it polls`);

  return {
    ok:              true,
    plannerJsonPath,
    message,
    targetGroups,
    plan,
    summary:         `plan written (${targetGroups.length} groups: ${targetGroups.join(", ")}) at ${plannerJsonPath}`,
  };
}

// This module is import-only — there is no CLI entry. The orchestrator
// (broadcast.mjs) is the sole caller. If you want to exercise the composer
// in isolation for debugging, import runPersonalLine and call it directly.
