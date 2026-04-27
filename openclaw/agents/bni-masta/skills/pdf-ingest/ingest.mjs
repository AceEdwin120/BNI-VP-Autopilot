#!/usr/bin/env node
// pdf-ingest — convert PDF → markdown chunks under raw/handbooks/<slug>/
//
// Usage: node ingest.mjs <pdf_path> [slug]
//
// Pipeline:
//   1. Detect text layer via pdftotext -layout sampled on first 5 pages.
//   2. If text layer present → pdftotext -layout, 20 pages/chunk. (fast + free)
//   3. If scanned: pick OCR engine in this order:
//        a) Gemini 2.5 Flash via OpenRouter (OPENROUTER_API_KEY env) — best for
//           Traditional Chinese; sends page rasters as PNG via vision
//        b) ocrmypdf --force-ocr --language=chi_tra+eng (local fallback)
//   4. Write raw/handbooks/<slug>/page_NNN-NNN.md + _manifest.json
//
// Deps: pdftotext, pdfinfo, pdftoppm (poppler) · ocrmypdf+tesseract-lang (optional fallback)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const VAULT = "<vault-path>";
const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
const CHUNK_SIZE = 20;            // pages per output markdown file
const MIN_CHARS_PER_PAGE = 300;
const OR_MODEL = "google/gemini-2.5-flash";
const OR_RASTER_DPI = 200;
const OR_BATCH_SIZE = 5;          // pages per OpenRouter API call (keeps payload ≤ ~5MB)
const OR_MAX_RETRIES = 4;
const OR_BACKOFF_MS = 3000;

// ---------- helpers ----------
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

function slugify(s) { return s.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fff.-]+/g, "_"); }
function have(bin) { return spawnSync("which", [bin]).status === 0; }
function pageCount(pdf) {
  const out = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  return parseInt(out.match(/Pages:\s+(\d+)/)[1], 10);
}
function pdftotextRange(pdf, first, last) {
  const r = spawnSync("pdftotext", ["-layout", "-f", String(first), "-l", String(last), pdf, "-"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pdftotext: ${r.stderr}`);
  return r.stdout;
}
function meaningfulCharCount(text) {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x30 && cp <= 0x39) ||
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a)) n++;
  }
  return n;
}
function looksScanned(pdf, total) {
  const end = Math.min(5, total);
  const sample = pdftotextRange(pdf, 1, end);
  const perPage = meaningfulCharCount(sample) / end;
  console.log(`[detect] ${perPage.toFixed(0)} meaningful chars/page (threshold ${MIN_CHARS_PER_PAGE})`);
  return perPage < MIN_CHARS_PER_PAGE;
}

// ---------- Gemini OCR via OpenRouter ----------
function rasterizePages(pdf, first, last, outDir) {
  // pdftoppm -r 200 -png -f <f> -l <l> <pdf> <outDir>/page
  const prefix = join(outDir, "p");
  const r = spawnSync(
    "pdftoppm",
    ["-r", String(OR_RASTER_DPI), "-png", "-f", String(first), "-l", String(last), pdf, prefix],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) throw new Error("pdftoppm failed");
  // Returns array of { page, path } in page order
  const pages = [];
  for (let p = first; p <= last; p++) {
    const pad = String(p).padStart(last >= 100 ? 3 : last >= 10 ? 2 : 1, "0");
    const candidates = [`${prefix}-${pad}.png`, `${prefix}-${p}.png`];
    const hit = candidates.find(existsSync);
    if (!hit) throw new Error(`pdftoppm: missing page ${p}`);
    pages.push({ page: p, path: hit });
  }
  return pages;
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geminiOcrBatch(pagePaths, firstPage) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const imageParts = pagePaths.map(p => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${readFileSync(p).toString("base64")}` },
  }));
  const body = {
    model: OR_MODEL,
    messages: [
      {
        role: "system",
        content: "You are an OCR engine for scanned Traditional Chinese + English business documents. For each image (one PDF page), produce the text EXACTLY as it appears, preserving headings, tables, bullet lists, and paragraph breaks. Use Markdown structure (## for section headers, bullets, tables). Preserve Traditional Chinese characters. Do NOT summarize. Do NOT translate. Separate pages with a line: `\\n\\n--- page N ---\\n\\n`.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Transcribe these ${pagePaths.length} pages (starting at page ${firstPage}) verbatim to markdown. Label each as '--- page ${firstPage} ---', '--- page ${firstPage+1} ---', etc.` },
          ...imageParts,
        ],
      },
    ],
  };
  let lastErr;
  for (let attempt = 1; attempt <= OR_MAX_RETRIES; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://github.com/<your-github>/<your-repo>",
          "X-Title": "BNI-Masta pdf-ingest",
        },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const j = await r.json();
        return j.choices?.[0]?.message?.content ?? "";
      }
      const text = (await r.text()).slice(0, 300);
      // 5xx + 429 → retry
      if (r.status >= 500 || r.status === 429) {
        lastErr = new Error(`OpenRouter ${r.status}: ${text}`);
        const wait = OR_BACKOFF_MS * attempt;
        console.log(`  [retry ${attempt}/${OR_MAX_RETRIES}] ${r.status} — sleeping ${wait}ms`);
        await sleep(wait);
        continue;
      }
      // 4xx other than 429 → don't retry
      throw new Error(`OpenRouter ${r.status}: ${text}`);
    } catch (e) {
      lastErr = e;
      if (attempt === OR_MAX_RETRIES) throw e;
      const wait = OR_BACKOFF_MS * attempt;
      console.log(`  [retry ${attempt}/${OR_MAX_RETRIES}] ${e.message.slice(0, 80)} — sleeping ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function geminiOcrRange(pdf, first, last) {
  const tmp = mkdtempSync(join(tmpdir(), "pdfocr-"));
  try {
    const pages = rasterizePages(pdf, first, last, tmp);
    let combined = "";
    for (let i = 0; i < pages.length; i += OR_BATCH_SIZE) {
      const batch = pages.slice(i, i + OR_BATCH_SIZE);
      const startPage = batch[0].page;
      const endPage = batch[batch.length - 1].page;
      console.log(`    · Gemini batch p${startPage}-${endPage} (${batch.length} pages)…`);
      const text = await geminiOcrBatch(batch.map(b => b.path), startPage);
      combined += (combined ? "\n\n" : "") + text.trim();
    }
    return combined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- ocrmypdf (fallback) ----------
function ocrmypdfRun(srcPdf) {
  if (!have("ocrmypdf")) throw new Error("ocrmypdf not installed — brew install ocrmypdf tesseract-lang");
  const out = srcPdf.replace(/\.pdf$/i, "") + ".ocr.pdf";
  if (existsSync(out)) { console.log(`[fallback-ocr] cached ${out}`); return out; }
  console.log(`[fallback-ocr] ocrmypdf running (3-8 min)…`);
  const r = spawnSync("ocrmypdf", ["--rotate-pages", "--deskew", "--force-ocr", "--language=chi_tra+eng", "--jobs", "4", srcPdf, out], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error("ocrmypdf failed");
  return out;
}

// ---------- main ----------
async function main() {
  const [, , pdfArg, slugArg] = process.argv;
  if (!pdfArg) { console.error("usage: ingest.mjs <pdf_path> [slug]"); process.exit(2); }
  const src = resolve(pdfArg);
  if (!existsSync(src)) { console.error(`not found: ${src}`); process.exit(2); }
  const slug = slugArg || slugify(basename(src));
  const outDir = join(VAULT, "raw/handbooks", slug);
  mkdirSync(outDir, { recursive: true });

  const total = pageCount(src);
  console.log(`▸ detecting text layer on ${total}-page PDF…`);

  const scanned = looksScanned(src, total);
  let engine;
  let workingPdf = src;
  if (!scanned) {
    engine = "pdftotext (text-layer)";
    console.log(`✓ text layer present — using pdftotext`);
  } else if (process.env.OPENROUTER_API_KEY) {
    engine = `openrouter:${OR_MODEL}`;
    console.log(`▸ scanned — using OpenRouter ${OR_MODEL} for OCR`);
  } else if (have("ocrmypdf")) {
    engine = "ocrmypdf (fallback)";
    console.log(`▸ scanned, no OpenRouter key — falling back to ocrmypdf`);
    workingPdf = ocrmypdfRun(src);
  } else {
    console.error(`✗ scanned PDF but no OCR engine available. Set OPENROUTER_API_KEY or install ocrmypdf.`);
    process.exit(1);
  }

  console.log(`▸ chunking ${total}p × ${CHUNK_SIZE}/chunk · engine=${engine}…`);
  const chunks = [];
  const ts = new Date().toISOString();
  for (let first = 1; first <= total; first += CHUNK_SIZE) {
    const last = Math.min(first + CHUNK_SIZE - 1, total);
    let body;
    if (engine.startsWith("openrouter")) {
      body = await geminiOcrRange(src, first, last);
    } else {
      body = pdftotextRange(workingPdf, first, last);
    }
    const name = `page_${String(first).padStart(3, "0")}-${String(last).padStart(3, "0")}.md`;
    const md = `# ${slug} — pages ${first}-${last}\n\n> Source: \`${src}\` · engine=\`${engine}\` · extracted ${ts}\n\n${body.trim()}\n`;
    writeFileSync(join(outDir, name), md);
    chunks.push({ file: name, first, last, chars: body.length });
    console.log(`  + ${name} (${body.length} chars)`);
  }

  writeFileSync(join(outDir, "_manifest.json"), JSON.stringify({
    source_pdf: src, working_pdf: workingPdf, engine, slug,
    total_pages: total, chunks, ingested_at: ts,
  }, null, 2));
  console.log(`✓ chunked ${total}p → ${chunks.length} files at raw/handbooks/${slug}/`);
  console.log(`  next: ingest-claude raw/handbooks/${slug}`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
