#!/usr/bin/env node
// ai-news-scrape — Stage 2 of the AI News Broadcaster.
//
// Calls Apify's Facebook posts actor (apify/facebook-posts-scraper) for every
// active Facebook source listed in ../../config/sources.json, normalizes the
// returned posts into a unified shape, dedupes against the prior 3 runs, and
// writes the deduped output to <vault>/raw/ai_news/<YYYY-MM-DD>/<HHmm>_scrape.json.
//
// This script lives one level deeper than the parent BNI Masta autoload root
// (extensions/ai-news-broadcaster/skills/...), so the parent agent does NOT
// auto-pick it up. Invocation is by direct path or by the Stage 5 orchestrator.
//
// Usage:
//   node scrape.mjs                                  # full run, last 72h, all active sources
//   node scrape.mjs --dry-run                        # emit a fixture, no Apify calls
//   node scrape.mjs --source openai-fb               # single source for testing
//   node scrape.mjs --since-hours 24                 # override window (default 72; v3 daily cadence widened from 48 to 72)
//   node scrape.mjs --per-page-limit 10              # override per-page cap (default 25)
//   node scrape.mjs --out /path/to/file.json         # override output path
//   node scrape.mjs --no-dedupe                      # skip prior-3-runs dedupe
//
// Exit codes:
//   0   success, output + marker written
//   1   fatal error (no APIFY_TOKEN, sources.json malformed, write failure, ...)
//   2   bad CLI usage

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Apify actor pin ─────────────────────────────────────────────────────────
// Locked at Stage 2 — see MANIFEST.md §6 for selection rationale. If a future
// stage needs to swap actors, change this string AND update MANIFEST.md.
const APIFY_ACTOR = "apify/facebook-posts-scraper";

// ── Paths ───────────────────────────────────────────────────────────────────
const EXTENSION_ROOT = resolve(__dirname, "..", "..");                    // extensions/ai-news-broadcaster
const SOURCES_DEFAULT = join(EXTENSION_ROOT, "config", "sources.json");
const SECRETS = process.env.BNI_SECRETS_FILE
  || "~/.openclaw/secrets/bni-masta.env";

// Vault root resolution. Resolved at call time inside runScrape so the Stage 5
// orchestrator can override it via opts.vaultRoot per run, even after this
// module has been imported. Standalone CLI usage falls through to the env or
// the long-standing default.
function resolveVault(opts) {
  if (opts && opts.vaultRoot) return opts.vaultRoot;
  if (process.env.BNI_VAULT_DIR) return process.env.BNI_VAULT_DIR;
  return "<vault-path>";
}

// ── Tiny env loader (vendored from existing skills) ─────────────────────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS);

// ── CLI parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    dryRun: false,
    source: null,
    sinceHours: 72,
    perPageLimit: 25,
    outOverride: null,
    sourcesPath: process.env.BNI_AINEWS_SOURCES_FILE || SOURCES_DEFAULT,
    noDedupe: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-dedupe") out.noDedupe = true;
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--since-hours") out.sinceHours = Number(argv[++i]);
    else if (a === "--per-page-limit") out.perPageLimit = Number(argv[++i]);
    else if (a === "--out") out.outOverride = argv[++i];
    else if (a === "--sources") out.sourcesPath = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.error(usage());
      process.exit(0);
    } else {
      console.error(`✗ unknown argument: ${a}\n`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.sinceHours) || out.sinceHours <= 0) {
    console.error(`✗ --since-hours must be a positive number`);
    process.exit(2);
  }
  if (!Number.isFinite(out.perPageLimit) || out.perPageLimit <= 0) {
    console.error(`✗ --per-page-limit must be a positive number`);
    process.exit(2);
  }
  return out;
}

function usage() {
  return [
    "ai-news-scrape — Apify Facebook scraper (Stage 2)",
    "",
    "Usage:",
    "  node scrape.mjs [--dry-run] [--source <id>] [--since-hours <n>]",
    "                  [--per-page-limit <n>] [--out <path>] [--no-dedupe]",
    "                  [--sources <path>]",
    "",
    "Env:",
    "  APIFY_TOKEN              required for live runs (not for --dry-run)",
    "  BNI_VAULT_DIR            override vault root (defaults to BNI AGENT)",
    "  BNI_AINEWS_SOURCES_FILE  override sources.json path",
    "  BNI_SECRETS_FILE         override secrets file path",
    "",
    "See ../../MANIFEST.md and ./SKILL.md for the full contract.",
  ].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sha12(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function taipeiNow() {
  // Compute YYYY-MM-DD and HHmm in Asia/Taipei without external deps.
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

function loadSources(p) {
  if (!existsSync(p)) {
    console.error(`✗ sources file not found: ${p}`);
    process.exit(1);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { console.error(`✗ sources file malformed: ${e.message}`); process.exit(1); }
  if (!raw || !Array.isArray(raw.sources)) {
    console.error(`✗ sources file must have a top-level "sources" array`);
    process.exit(1);
  }
  return raw.sources;
}

// Pull a value from a possibly-mapped Apify post output. Different Apify FB
// actors / versions name fields slightly differently. Try the common names.
function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === "number") {
    // Treat values <1e12 as seconds since epoch, else ms.
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalizePost(raw, source) {
  const post_url = String(pick(raw, ["postUrl", "url", "permalinkUrl", "topLevelUrl", "facebookUrl"]) || "");
  if (!post_url) return null;
  const text = String(pick(raw, ["text", "message", "postText", "content", "fullText"], "") || "");
  const author = String(pick(raw, ["pageName", "userName", "authorName", "user", "owner", "page"], source.page_handle) || source.page_handle);
  const posted_at_raw = pick(raw, ["time", "timestamp", "publishedTime", "creationTime", "date", "postedAt"]);
  const likes = Number(pick(raw, ["likesCount", "likes", "reactionsCount"], 0)) || 0;
  const comments = Number(pick(raw, ["commentsCount", "comments"], 0)) || 0;
  const shares = Number(pick(raw, ["sharesCount", "shares"], 0)) || 0;

  // image_urls: try a few typical container keys
  let image_urls = [];
  const media = pick(raw, ["media", "images", "pictures", "attachments"]);
  if (Array.isArray(media)) {
    for (const m of media) {
      const u = typeof m === "string" ? m : pick(m, ["url", "src", "image", "thumbnailUrl", "uri"]);
      if (u) image_urls.push(String(u));
    }
  }
  if (image_urls.length === 0) {
    const single = pick(raw, ["image", "thumbnailUrl", "previewImage"]);
    if (single) image_urls.push(String(single));
  }

  return {
    id: sha12(post_url),
    source_id: source.id,
    platform: source.platform,
    post_url,
    author: typeof author === "object" ? (author.name || source.page_handle) : author,
    posted_at: toIso(posted_at_raw),
    text,
    image_urls,
    engagement: { likes, comments, shares },
    scraped_at: new Date().toISOString(),
  };
}

// ── Prior-runs dedupe ───────────────────────────────────────────────────────
// Reads up to the 3 most recent prior daily folders under raw/ai_news/ and
// gathers all post ids written in any scrape_*.json. Posts with matching ids
// are dropped from the current run.
function loadPriorIds(rawRoot, currentDate) {
  const ids = new Set();
  if (!existsSync(rawRoot)) return ids;
  let dirs;
  try {
    dirs = readdirSync(rawRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name <= currentDate)
      .map(d => d.name)
      .sort()
      .slice(-3);
  } catch (_) { return ids; }
  for (const date of dirs) {
    const dayDir = join(rawRoot, date);
    let files;
    try {
      files = readdirSync(dayDir).filter(n => /scrape.*\.json$/i.test(n));
    } catch (_) { continue; }
    for (const fn of files) {
      try {
        const obj = JSON.parse(readFileSync(join(dayDir, fn), "utf8"));
        const arr = Array.isArray(obj) ? obj : (obj.posts || []);
        for (const p of arr) if (p && p.id) ids.add(p.id);
      } catch (_) { /* skip bad file */ }
    }
  }
  return ids;
}

// ── Apify call (dynamic import — only when not --dry-run) ───────────────────
async function callApifyForSource(source, sinceHours, perPageLimit) {
  const { ApifyClient } = await import("apify-client");
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

  // The apify/facebook-posts-scraper actor accepts `startUrls` (array of
  // URLs or handles) and `resultsLimit` / `maxPosts` (per-page cap). Field
  // names have varied slightly across versions, so we pass the conservative
  // superset; unknown keys are ignored by the actor.
  const sinceCutoffMs = Date.now() - sinceHours * 3600 * 1000;
  const sinceIso = new Date(sinceCutoffMs).toISOString();
  const input = {
    startUrls: [{ url: source.page_url }],
    resultsLimit: perPageLimit,
    maxPosts: perPageLimit,
    onlyPostsNewerThan: sinceIso,
  };

  const run = await client.actor(APIFY_ACTOR).call(input);
  const dataset = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
  return dataset.items || [];
}

// ── Fixture for --dry-run ──────────────────────────────────────────────────
function fixturePostsFor(source, perPageLimit) {
  // Emit a deterministic 2-post fixture per source so the dedupe path is also
  // exercisable without any network. Capped at perPageLimit.
  const now = Date.now();
  const out = [];
  for (let i = 0; i < Math.min(2, perPageLimit); i++) {
    const post_url = `https://www.facebook.com/${source.page_handle}/posts/fixture-${source.id}-${i}`;
    out.push({
      id: sha12(post_url),
      source_id: source.id,
      platform: source.platform,
      post_url,
      author: source.page_handle,
      posted_at: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
      text: `[fixture] ${source.page_handle} mock post #${i + 1} — generated by --dry-run, no network call.`,
      image_urls: [],
      engagement: { likes: 100 + i, comments: 10 + i, shares: 1 + i },
      scraped_at: new Date().toISOString(),
    });
  }
  return out;
}

// ── Core: runScrape(opts) ───────────────────────────────────────────────────
// In-process entry point used by the Stage 5 orchestrator. Same work the CLI
// does, just structured as a function that takes a typed options object and
// returns a result object instead of writing the OK summary to stdout / calling
// process.exit on bad input. The CLI main() below is a thin shell over this.
//
// Throws Error on hard failures (bad input, write failure, missing token in a
// non-dry-run, etc.). Per-source scrape errors are swallowed and recorded in
// the returned `sourceStats`, mirroring the original CLI behavior.
//
// Returns:
//   { ok, summary, outputPath, markerPath, postsCount, sourcesCount,
//     droppedDuplicates, sourceStats, runDate, runHhmm }
export async function runScrape({
  dryRun = false,
  source = null,
  sinceHours = 72,
  perPageLimit = 25,
  out = null,
  noDedupe = false,
  sourcesPath = null,
  vaultRoot = null,
} = {}) {
  if (!dryRun && !process.env.APIFY_TOKEN) {
    throw new Error([
      "APIFY_TOKEN not set.",
      "  Set it in ~/.openclaw/secrets/bni-masta.env (see MANIFEST.md §6.2),",
      "  or run with --dry-run to emit a fixture without calling Apify.",
    ].join("\n"));
  }

  const sourcesFile = sourcesPath
    || process.env.BNI_AINEWS_SOURCES_FILE
    || SOURCES_DEFAULT;
  const allSources = loadSources(sourcesFile);
  let sources = allSources.filter(s => s.active === true && s.platform === "facebook");
  if (source) {
    sources = sources.filter(s => s.id === source);
    if (sources.length === 0) {
      throw new Error(`--source ${source} not found, or not active+facebook in sources.json`);
    }
  }
  if (sources.length === 0) {
    throw new Error(`no active facebook sources matched`);
  }

  const VAULT = resolveVault({ vaultRoot });
  const { date, hhmm } = taipeiNow();
  const rawRoot = join(VAULT, "raw", "ai_news");
  const dayDir = join(rawRoot, date);
  const outPath = out || join(dayDir, `${hhmm}_scrape.json`);
  const markerPath = join(dayDir, `${hhmm}.scrape_done`);

  // Ensure output dir exists (even for --dry-run we write a real fixture so the
  // user can inspect it). The vault dir might not exist on this dev machine —
  // tolerate that by creating recursively.
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(markerPath), { recursive: true });

  // Gather posts per-source with per-source try/catch so one failure does not
  // abort the whole run.
  const allPosts = [];
  const sourceStats = [];
  for (const src of sources) {
    try {
      const raw = dryRun
        ? fixturePostsFor(src, perPageLimit)
        : await callApifyForSource(src, sinceHours, perPageLimit);
      // For dry-run the fixture is already in normalized shape (has .id).
      // For live runs we normalize from the actor's raw output.
      const normalized = dryRun
        ? raw
        : raw.map(r => normalizePost(r, src)).filter(Boolean);
      // Apply --since-hours filter post-hoc too, in case the actor ignores it.
      const cutoffMs = Date.now() - sinceHours * 3600 * 1000;
      const fresh = normalized.filter(p => {
        if (!p.posted_at) return true; // keep undated rather than drop silently
        return Date.parse(p.posted_at) >= cutoffMs;
      });
      allPosts.push(...fresh);
      sourceStats.push({ source_id: src.id, raw: raw.length, kept: fresh.length, ok: true });
    } catch (e) {
      console.error(`  ⚠ ${src.id}: ${e.message || e}`);
      sourceStats.push({ source_id: src.id, raw: 0, kept: 0, ok: false, error: String(e.message || e) });
    }
  }

  // Dedupe against prior 3 runs.
  let droppedDup = 0;
  let postsOut = allPosts;
  if (!noDedupe) {
    const priorIds = loadPriorIds(rawRoot, date);
    const seen = new Set();
    const filtered = [];
    for (const p of postsOut) {
      if (priorIds.has(p.id) || seen.has(p.id)) {
        droppedDup++;
        continue;
      }
      seen.add(p.id);
      filtered.push(p);
    }
    postsOut = filtered;
  }

  const output = {
    schema_version: 1,
    run: {
      date,
      hhmm,
      timezone: "Asia/Taipei",
      since_hours: sinceHours,
      per_page_limit: perPageLimit,
      dry_run: dryRun,
      no_dedupe: noDedupe,
      apify_actor: dryRun ? null : APIFY_ACTOR,
      generated_at: new Date().toISOString(),
    },
    sources: sourceStats,
    posts: postsOut,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  writeFileSync(markerPath, JSON.stringify({
    done: true,
    at: new Date().toISOString(),
    post_count: postsOut.length,
    source_count: sources.length,
    dropped_duplicates: droppedDup,
    dry_run: dryRun,
    output: outPath,
  }, null, 2));

  return {
    ok: true,
    summary: `[ai-news-scrape] OK — ${postsOut.length} posts from ${sources.length} sources, ${droppedDup} duplicates dropped, output: ${outPath}`,
    outputPath: outPath,
    markerPath,
    postsCount: postsOut.length,
    sourcesCount: sources.length,
    droppedDuplicates: droppedDup,
    sourceStats,
    runDate: date,
    runHhmm: hhmm,
  };
}

// ── CLI shell ───────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const result = await runScrape({
    dryRun: a.dryRun,
    source: a.source,
    sinceHours: a.sinceHours,
    perPageLimit: a.perPageLimit,
    out: a.outOverride,
    noDedupe: a.noDedupe,
    sourcesPath: a.sourcesPath,
  });
  console.log(result.summary);
}

// Only run the CLI when invoked directly (node scrape.mjs ...). When imported
// by the Stage 5 orchestrator, the module exports stay accessible without
// running main() automatically.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(`✗ ${e.stack || e.message || e}`);
    process.exit(1);
  });
}
