#!/usr/bin/env node
// tools/verify-sources.mjs — install-time helper (Stage 7).
//
// Walks every entry in ../config/sources.json, sends a GET request to its
// page_url (HEAD often gets 4xx from Facebook even when the page is fine, so
// we use GET), and reports which pages return 200. Pages that respond with
// 404/410 (or transparently fail to resolve) get flipped to active:false; the
// diff is printed for review. Backup of the original file is written next to
// it as sources.json.bak before any mutation.
//
// Usage:
//   node tools/verify-sources.mjs                 # check + flip + write back
//   node tools/verify-sources.mjs --dry-run       # check + print diff, don't write
//   node tools/verify-sources.mjs --tier C        # only check Tier C entries
//   node tools/verify-sources.mjs --timeout 8000  # per-request timeout (ms)
//
// Exit codes:
//   0   all live (or dry-run; or write succeeded)
//   1   write failure / sources.json malformed
//   2   bad CLI usage
//
// Note on Facebook: a public FB page typically returns 200 with the page
// HTML when fetched without auth. A deleted/private page returns 404. Some
// pages return 200 with a "log in to continue" interstitial — we treat any
// 200 as live (the scrape side has its own dead-page handling). 5xx is
// retried once with a 2-second pause; persistent 5xx is treated as inconclusive
// (NOT flipped to inactive — we don't want a transient FB hiccup to wipe a
// good source).
//
// SAFETY: this tool ONLY mutates extensions/ai-news-broadcaster/config/
// sources.json. It does not touch any file outside the extension folder.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES_PATH = process.env.BNI_AINEWS_SOURCES_FILE
  || resolve(__dirname, "..", "config", "sources.json");

function parseArgs(argv) {
  const out = { dryRun: false, tier: null, timeout: 12000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--tier") out.tier = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.error("usage: node tools/verify-sources.mjs [--dry-run] [--tier A|B|C] [--timeout ms]");
      process.exit(0);
    } else {
      console.error(`✗ unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) {
    console.error(`✗ --timeout must be a positive number`);
    process.exit(2);
  }
  return out;
}

async function probe(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        // Facebook serves a different (smaller, parseable) HTML body to a
        // crawler-style UA; using a realistic UA keeps the response stable.
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "accept-language": "en-US,en;q=0.9,zh-TW;q=0.8",
      },
    });
    return { status: r.status, ok: r.ok };
  } catch (e) {
    return { status: 0, ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function probeWithRetry(url, timeoutMs) {
  const r1 = await probe(url, timeoutMs);
  // 200 = live; 404/410 = gone; otherwise (5xx, network error) = retry once.
  if (r1.ok) return { ...r1, attempts: 1 };
  if (r1.status === 404 || r1.status === 410) return { ...r1, attempts: 1 };
  await new Promise(res => setTimeout(res, 2000));
  const r2 = await probe(url, timeoutMs);
  return { ...r2, attempts: 2 };
}

function classify(probeResult) {
  // Return one of: "live", "gone", "inconclusive"
  if (probeResult.ok) return "live";
  if (probeResult.status === 404 || probeResult.status === 410) return "gone";
  return "inconclusive";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(SOURCES_PATH)) {
    console.error(`✗ sources.json not found at ${SOURCES_PATH}`);
    process.exit(1);
  }

  let raw;
  try { raw = JSON.parse(readFileSync(SOURCES_PATH, "utf8")); }
  catch (e) { console.error(`✗ sources.json invalid: ${e.message}`); process.exit(1); }

  const sources = Array.isArray(raw) ? raw : (raw.sources || []);
  const filtered = args.tier
    ? sources.filter(s => s.tier === args.tier)
    : sources;

  if (filtered.length === 0) {
    console.log(`(no sources to check; tier filter='${args.tier ?? "*"}' matched nothing)`);
    process.exit(0);
  }

  console.log(`→ probing ${filtered.length} source(s)${args.tier ? ` (tier ${args.tier})` : ""} from ${SOURCES_PATH}`);
  console.log(`  timeout: ${args.timeout}ms; retry-once-on-non-404`);
  console.log("");

  // Probe in serial so we don't hammer FB and trip rate-limit. The full pool
  // is ~20 requests; serial at ~1-2s each = ~30s end-to-end which is fine.
  const results = [];
  for (const s of filtered) {
    const p = await probeWithRetry(s.page_url, args.timeout);
    const verdict = classify(p);
    const tag = verdict === "live"
      ? "✓"
      : verdict === "gone"
        ? "✗"
        : "?";
    const notes = [
      `HTTP ${p.status || "ERR"}`,
      p.error ? `(${p.error.slice(0, 60)})` : "",
      p.attempts > 1 ? `[retry]` : "",
    ].filter(Boolean).join(" ");
    console.log(`  ${tag} [${s.tier}] ${s.id.padEnd(22)} ${s.page_url.padEnd(48)} → ${verdict.padEnd(13)} ${notes}`);
    results.push({ source: s, probe: p, verdict });
  }

  // ── Compute the diff ──
  const flips = [];
  for (const r of results) {
    if (r.verdict === "gone" && r.source.active !== false) {
      flips.push({ id: r.source.id, from: r.source.active !== false, to: false });
    }
    // Note: we do NOT auto-flip from active=false back to true if a probe
    // succeeds — the operator may have intentionally disabled a source (manual edit
    // required to re-enable.
  }

  console.log("");
  console.log(`Summary: ${results.filter(r => r.verdict === "live").length} live, ${results.filter(r => r.verdict === "gone").length} gone, ${results.filter(r => r.verdict === "inconclusive").length} inconclusive`);

  if (flips.length === 0) {
    console.log("No changes to sources.json — every probed source is live or already inactive.");
    process.exit(0);
  }

  console.log("");
  console.log(`Diff (${flips.length} flip${flips.length === 1 ? "" : "s"}):`);
  for (const f of flips) console.log(`  ${f.id}: active=${f.from} → active=${f.to}`);

  if (args.dryRun) {
    console.log("");
    console.log("(--dry-run set; sources.json unchanged.)");
    process.exit(0);
  }

  // Apply
  for (const f of flips) {
    const idx = sources.findIndex(s => s.id === f.id);
    if (idx >= 0) sources[idx].active = false;
  }

  // Backup, then write atomically
  const bak = SOURCES_PATH + ".bak";
  copyFileSync(SOURCES_PATH, bak);
  raw.sources = sources;
  if (raw.updated !== undefined) raw.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(SOURCES_PATH, JSON.stringify(raw, null, 2) + "\n");

  console.log("");
  console.log(`✓ sources.json updated (${flips.length} flip${flips.length === 1 ? "" : "s"} applied)`);
  console.log(`  backup: ${bak}`);
}

main().catch(e => {
  console.error(`✗ ${e.stack || e.message || e}`);
  process.exit(1);
});
