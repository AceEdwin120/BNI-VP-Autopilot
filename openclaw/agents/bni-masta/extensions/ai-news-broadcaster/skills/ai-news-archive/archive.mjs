#!/usr/bin/env node
// ai-news-archive — Stage 4 of the AI News Broadcaster.
//
// Takes the Stage-2 scrape JSON, the Stage-3 curated.json, and the Stage-3
// rendered deck.pdf, and writes a single browseable Markdown archive doc to
// <vault-root>/archive/ai_news/<YYYY-MM-DD>_<HHmm>.md, copies the deck PDF
// next to it, prepends a row to <vault-root>/archive/ai_news/INDEX.md, and
// writes an idempotency marker at raw/ai_news/<date>/<hhmm>.archive_done.
//
// This script lives one level deeper than the parent BNI Masta autoload root
// (extensions/ai-news-broadcaster/skills/...), so the parent agent does NOT
// auto-pick it up. Invocation is by direct path or by the Stage 5 orchestrator.
//
// Usage:
//   node archive.mjs --scrape <scrape.json> --curated <curated.json>
//                    --deck <deck.pdf> [--vault-root <path>] [--dry-run]
//
// Exit codes:
//   0   success — archive .md, deck pdf copy, INDEX.md, marker all written
//   1   fatal error (inputs missing/malformed, vault unresolvable, write fail, ...)
//   2   bad CLI usage

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Pinned metadata referenced inside the archive doc ───────────────────────
const EXTENSION_VERSION = "0.4";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // mirrors deck.mjs
const APIFY_ACTOR = "apify/facebook-posts-scraper";   // mirrors scrape.mjs
const SCRAPE_WINDOW_HOURS = 48;                        // plan §10
const DEDUPE_WINDOW_RUNS = 3;                          // plan §8 stage 4

// ── Paths ───────────────────────────────────────────────────────────────────
const SECRETS = process.env.BNI_SECRETS_FILE
  || "~/.openclaw/secrets/bni-masta.env";

// ── Tiny env loader ─────────────────────────────────────────────────────────
// Vendored pattern (see deck.mjs / scrape.mjs) — kept independent per MANIFEST policy.
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
    scrape: null,
    curated: null,
    deck: null,
    vaultRoot: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scrape") out.scrape = argv[++i];
    else if (a === "--curated") out.curated = argv[++i];
    else if (a === "--deck") out.deck = argv[++i];
    else if (a === "--vault-root") out.vaultRoot = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.error(usage());
      process.exit(0);
    } else {
      console.error(`✗ unknown argument: ${a}\n`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!out.scrape) {
    console.error(`✗ --scrape <scrape.json> required\n`);
    console.error(usage());
    process.exit(2);
  }
  if (!out.curated) {
    console.error(`✗ --curated <curated.json> required\n`);
    console.error(usage());
    process.exit(2);
  }
  if (!out.deck) {
    console.error(`✗ --deck <deck.pdf> required\n`);
    console.error(usage());
    process.exit(2);
  }
  return out;
}

function usage() {
  return [
    "ai-news-archive — Markdown archive + INDEX writer (Stage 4)",
    "",
    "Usage:",
    "  node archive.mjs --scrape <scrape.json> --curated <curated.json>",
    "                   --deck <deck.pdf> [--vault-root <path>] [--dry-run]",
    "",
    "Env:",
    "  BNI_VAULT_ROOT           vault root path (preferred)",
    "  BNI_VAULT_DIR            vault root path (fallback, mirrors scrape.mjs)",
    "  BNI_SECRETS_FILE         override secrets file path",
    "",
    "Vault-root resolution order:",
    "  1. --vault-root flag",
    "  2. BNI_VAULT_ROOT env",
    "  3. BNI_VAULT_DIR  env (matches scrape.mjs convention)",
    "  4. <repo-path>/openclaw/vault (if it exists)",
    "  5. <vault-path> (matches scrape.mjs default)",
    "",
    "See ../../MANIFEST.md and ./SKILL.md for the full contract.",
  ].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, "0"); }

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
    pretty: `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

// Note: an earlier process.exit-based readJson() helper was removed during the
// Stage 5 in-process refactor; runArchive() now uses readJsonOrThrow() (defined
// after main()) so import paths can recover from bad inputs without dying.

function resolveVaultRoot(argFlag) {
  // 1. flag
  if (argFlag) return resolve(argFlag);
  // 2. BNI_VAULT_ROOT
  if (process.env.BNI_VAULT_ROOT) return resolve(process.env.BNI_VAULT_ROOT);
  // 3. BNI_VAULT_DIR  (scrape.mjs convention)
  if (process.env.BNI_VAULT_DIR) return resolve(process.env.BNI_VAULT_DIR);
  // 4. project-relative convention if it actually exists on this machine
  const projVault = join(homedir(), "Documents", "Claude", "Projects",
                         "BNI-VP-Autopilot", "openclaw", "vault");
  if (existsSync(projVault)) return projVault;
  // 5. scrape.mjs default
  const scrapeDefault = "<vault-path>";
  if (existsSync(scrapeDefault)) return scrapeDefault;
  console.error([
    "✗ vault root not resolved.",
    "  Pass --vault-root <path> OR set BNI_VAULT_ROOT (or BNI_VAULT_DIR)",
    "  in ~/.openclaw/secrets/bni-masta.env.",
  ].join("\n"));
  process.exit(1);
}

// Find a non-colliding archive base name. Returns { mdPath, deckPath, suffix }.
// First attempts <date>_<hhmm>.md ; if exists, walks _2, _3, ... until free.
function pickArchivePaths(archiveDir, date, hhmm) {
  const tryBase = (suffix) => {
    const tag = suffix === 0 ? `${date}_${hhmm}` : `${date}_${hhmm}_${suffix}`;
    return {
      tag,
      mdPath: join(archiveDir, `${tag}.md`),
      deckPath: join(archiveDir, `${tag}.deck.pdf`),
    };
  };
  let suffix = 0;
  while (true) {
    const cand = tryBase(suffix);
    if (!existsSync(cand.mdPath) && !existsSync(cand.deckPath)) {
      return { ...cand, suffix };
    }
    suffix += 1;
    if (suffix > 99) {
      throw new Error(`refusing to allocate suffix > 99 at ${archiveDir}/${date}_${hhmm}`);
    }
  }
}

// ── Markdown rendering ──────────────────────────────────────────────────────
function escapePipe(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderArchiveMarkdown({
  pretty, runIsoTimestamp, runId,
  scrape, curated,
  deckRelPath,
  postsAfterDedupe, sourcesScanned,
}) {
  const items = curated.items || [];
  const tips = curated.tips_zhTW || [];

  const itemsBlock = items.map((it, idx) => {
    const headline = String(it.headline_zhTW || "(no headline)").trim();
    const url = String(it.source_url || "").trim();
    const author = String(it.author || it.source_id || "").trim();
    const posted = it.posted_at ? String(it.posted_at).slice(0, 10) : "—";
    const tier = it.tier || "?";
    const summary = String(it.summary_zhTW || "").trim();
    const why = String(it.why_it_matters_zhTW || "").trim();
    const linkLabel = url ? "[原文連結](" + url + ")" : "(無原文連結)";
    const authorLine = author ? `${author} · ` : "";
    return [
      `### ${idx + 1}. ${headline}`,
      `- **來源：** ${authorLine}${linkLabel} · ${posted}`,
      `- **Tier：** ${tier}`,
      `- **摘要：** ${summary}`,
      `- **為什麼重要：** ${why}`,
    ].join("\n");
  }).join("\n\n");

  const tipsBlock = tips.map((t, i) => `${i + 1}. ${String(t).trim()}`).join("\n");

  // Full scan table — sort by posted_at desc, fall back to scraped_at.
  const allPosts = (scrape && scrape.posts) ? scrape.posts.slice() : [];
  allPosts.sort((a, b) => {
    const at = a.posted_at ? Date.parse(a.posted_at) : 0;
    const bt = b.posted_at ? Date.parse(b.posted_at) : 0;
    return bt - at;
  });
  const tableHeader = "| # | Source | Author | Posted | Engagement | Link |\n|---|--------|--------|--------|------------|------|";
  const tableRows = allPosts.map((p, i) => {
    const eng = p.engagement || {};
    const engStr = `${eng.likes || 0}♥ / ${eng.comments || 0}💬 / ${eng.shares || 0}↻`;
    const posted = p.posted_at ? String(p.posted_at).slice(0, 16).replace("T", " ") : "—";
    const link = p.post_url ? `[link](${p.post_url})` : "—";
    return `| ${i + 1} | ${escapePipe(p.source_id)} | ${escapePipe(clip(p.author || "", 30))} | ${escapePipe(posted)} | ${escapePipe(engStr)} | ${link} |`;
  });
  const tableBlock = allPosts.length
    ? [tableHeader, ...tableRows].join("\n")
    : "_(no posts in this scrape)_";

  const sources = (scrape && scrape.sources) || [];
  const okSources = sources.filter(s => s.ok !== false).length;

  return `# AI 趨勢快訊 — ${pretty}

- **Run timestamp:** ${runIsoTimestamp}
- **Sources scanned:** ${sourcesScanned} pages, ${postsAfterDedupe} posts after dedupe
- **Top picks:** ${items.length}
- **Deck PDF:** [${basename(deckRelPath)}](${deckRelPath})
- **Generated by:** ai-news-broadcaster v${EXTENSION_VERSION}

---

## 精選三則 (繁體中文)

${itemsBlock || "_(no curated items)_"}

---

## 給<YourChapter> 夥伴的 Tips

${tipsBlock || "_(no tips)_"}

---

## 完整掃描清單 (raw)

${tableBlock}

---

## Run metadata
- **Apify actor:** ${APIFY_ACTOR}
- **Scrape window:** last ${SCRAPE_WINDOW_HOURS}h
- **Dedupe window:** prior ${DEDUPE_WINDOW_RUNS} runs
- **Curation model:** ${ANTHROPIC_MODEL}
- **Run ID:** ${runId}
- **Sources reachable:** ${okSources}/${sources.length}
`;
}

// ── INDEX.md handling ───────────────────────────────────────────────────────
const INDEX_HEADER = "# AI 趨勢快訊 — Archive Index";
const INDEX_TABLE_HEADER = "| Date | Time | Top headline (繁中) | Doc |";
const INDEX_TABLE_DIVIDER = "|------|------|---------------------|-----|";

function buildIndexInitial(date, hhmm, headline, mdFileName) {
  const row = `| ${date} | ${hhmm.slice(0, 2)}:${hhmm.slice(2)} | ${escapePipe(headline)} | [Open](${mdFileName}) |`;
  return [
    INDEX_HEADER,
    "",
    "_Newest first. Each row links to the per-run archive doc._",
    "",
    INDEX_TABLE_HEADER,
    INDEX_TABLE_DIVIDER,
    row,
    "",
  ].join("\n");
}

function prependIndexEntry(existing, date, hhmm, headline, mdFileName) {
  const row = `| ${date} | ${hhmm.slice(0, 2)}:${hhmm.slice(2)} | ${escapePipe(headline)} | [Open](${mdFileName}) |`;
  // Find the divider row — the new entry goes right after it.
  const lines = existing.split("\n");
  const dividerIdx = lines.findIndex(l => l.trim().startsWith("|---"));
  if (dividerIdx === -1) {
    // Existing INDEX is malformed/empty — rebuild fresh.
    return buildIndexInitial(date, hhmm, headline, mdFileName);
  }
  lines.splice(dividerIdx + 1, 0, row);
  return lines.join("\n");
}

// ── Core: runArchive(opts) ──────────────────────────────────────────────────
// In-process entry point used by the Stage 5 orchestrator. Same work the CLI
// does, just structured as a function that takes a typed options object and
// returns a result object instead of writing to disk + stdout from the same
// place. The CLI main() below is a thin shell over this.
//
// In dry-run mode we still compose the markdown and return it as `markdown`,
// but write nothing to disk and write nothing to stdout — the CLI shell
// handles the stdout dump for byte-identical CLI behavior.
//
// Throws Error on hard failures (missing/malformed inputs, missing deck file
// in non-dry-run mode, vault unresolvable, etc.).
//
// Returns:
//   { ok, summary, dryRun, markdown, mdPath?, deckPath?, indexPath?, markerPath?,
//     suffix?, runId, runDate, runHhmm, items, sourcesScanned, postsAfterDedupe }
export async function runArchive({
  scrape: scrapePathArg,
  curated: curatedPathArg,
  deck: deckPathArg,
  vaultRoot = null,
  dryRun = false,
} = {}) {
  if (!scrapePathArg)  throw new Error(`runArchive: --scrape <scrape.json> required`);
  if (!curatedPathArg) throw new Error(`runArchive: --curated <curated.json> required`);
  if (!deckPathArg)    throw new Error(`runArchive: --deck <deck.pdf> required`);

  const scrape = readJsonOrThrow("scrape", scrapePathArg);
  const curated = readJsonOrThrow("curated", curatedPathArg);

  if (!existsSync(deckPathArg)) {
    throw new Error(`deck PDF not found: ${deckPathArg}`);
  }

  // Run ID + timestamps. Prefer the scrape's recorded run-date/hhmm so the
  // archive doc names line up with the scrape and marker file, even if this
  // step runs minutes later. Fall back to current Taipei time.
  const fallback = taipeiNow();
  const date = (scrape?.run?.date) || fallback.date;
  const hhmm = (scrape?.run?.hhmm) || fallback.hhmm;
  const isoNow = new Date().toISOString();
  const pretty = `${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  const runId = `${date.replace(/-/g, "")}_${hhmm}`;

  const items = curated.items || [];
  const sourcesScanned = (scrape && Array.isArray(scrape.sources)) ? scrape.sources.length : 0;
  const postsAfterDedupe = (scrape && Array.isArray(scrape.posts)) ? scrape.posts.length : 0;
  const topHeadline = items[0]?.headline_zhTW || "(no headline)";

  const projectedDeckRelative = `${date}_${hhmm}.deck.pdf`;

  const md = renderArchiveMarkdown({
    pretty,
    runIsoTimestamp: isoNow,
    runId,
    scrape,
    curated,
    deckRelPath: projectedDeckRelative,
    postsAfterDedupe,
    sourcesScanned,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      markdown: md,
      runId, runDate: date, runHhmm: hhmm,
      items: items.length, sourcesScanned, postsAfterDedupe,
      summary: `[ai-news-archive] OK (dry-run) — ${md.length} chars composed in memory, nothing written`,
    };
  }

  // ── Real run: resolve vault, write files ──
  const vault = resolveVaultRoot(vaultRoot);
  const archiveDir = join(vault, "archive", "ai_news");
  mkdirSync(archiveDir, { recursive: true });

  const { mdPath, deckPath, suffix } = pickArchivePaths(archiveDir, date, hhmm);

  // If a suffix was used, we need to re-render the markdown with the right
  // deck filename so the relative link inside the .md matches the file we
  // actually copy.
  const finalDeckBase = basename(deckPath);
  const mdFinal = suffix === 0
    ? md
    : renderArchiveMarkdown({
        pretty, runIsoTimestamp: isoNow, runId,
        scrape, curated,
        deckRelPath: finalDeckBase,
        postsAfterDedupe, sourcesScanned,
      });

  writeFileSync(mdPath, mdFinal);
  copyFileSync(deckPathArg, deckPath);

  // INDEX.md — prepend or create.
  const indexPath = join(archiveDir, "INDEX.md");
  const mdFileName = basename(mdPath);
  let indexBody;
  if (existsSync(indexPath)) {
    const existing = readFileSync(indexPath, "utf8");
    indexBody = prependIndexEntry(existing, date, hhmm, topHeadline, mdFileName);
  } else {
    indexBody = buildIndexInitial(date, hhmm, topHeadline, mdFileName);
  }
  writeFileSync(indexPath, indexBody);

  // Idempotency marker — mirrors the scrape_done convention.
  const markerDir = join(vault, "raw", "ai_news", date);
  mkdirSync(markerDir, { recursive: true });
  const markerPath = join(markerDir, `${hhmm}.archive_done`);
  writeFileSync(markerPath, JSON.stringify({
    done: true,
    at: isoNow,
    run_id: runId,
    archive_md: mdPath,
    archive_deck_pdf: deckPath,
    index: indexPath,
    suffix,
    items: items.length,
    sources_scanned: sourcesScanned,
    posts_after_dedupe: postsAfterDedupe,
  }, null, 2));

  return {
    ok: true,
    dryRun: false,
    markdown: mdFinal,
    summary: `[ai-news-archive] OK — archive: ${mdPath}, deck: ${deckPath}, index updated`,
    mdPath, deckPath, indexPath, markerPath, suffix,
    runId, runDate: date, runHhmm: hhmm,
    items: items.length, sourcesScanned, postsAfterDedupe,
  };
}

// readJson() previously called process.exit(1) on missing/malformed input —
// fine for the standalone CLI but bad for in-process composition. The
// runArchive() entry point uses readJsonOrThrow() which signals via Error.
// readJson() is preserved (unused now) only to minimize diff churn for
// any future code that depended on the old name; kept private to this module.
function readJsonOrThrow(label, path) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`${label} malformed JSON (${path}): ${e.message}`); }
}

// ── CLI shell ───────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const result = await runArchive({
    scrape: a.scrape,
    curated: a.curated,
    deck: a.deck,
    vaultRoot: a.vaultRoot,
    dryRun: a.dryRun,
  });

  if (a.dryRun) {
    // Byte-identical CLI behavior: dump the rendered markdown to stdout, no
    // OK summary line.
    process.stdout.write(result.markdown);
    if (!result.markdown.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  console.log(result.summary);
}

// Only run the CLI when invoked directly. When the Stage 5 orchestrator
// imports runArchive, this guard keeps main() from auto-firing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(`✗ ${e.stack || e.message || e}`);
    process.exit(1);
  });
}
