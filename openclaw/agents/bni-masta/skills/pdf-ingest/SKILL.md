---
name: pdf-ingest
description: Ingest a PDF (BNI handbook, meeting deck, etc.) into the vault's raw/handbooks/ folder as markdown chunks, then trigger the Claude compiler to extract rules/pages into wiki/.
metadata:
  openclaw:
    emoji: "📘"
    requires:
      bins: [nano-pdf]
    triggers:
      - "user sends a PDF file to the bot"
      - "/pdf-ingest <path>"
---

# pdf-ingest

Takes a PDF path, chunks it into per-page markdown files under `raw/handbooks/<slug>/`, then invokes the `ingest-claude` skill to let Claude compile those raw chunks into cross-linked wiki pages.

## Inputs

- `pdf_path` — absolute path to a PDF file on disk (either sent by the operator to the bot, or a path they type)
- `slug` (optional) — folder name under `raw/handbooks/`. Default: sanitized PDF filename.

## Behavior

1. Validate PDF exists and is readable.
2. **Detect scanned vs text-layer**: sample first 5 pages via `pdftotext -layout`; count meaningful CJK/ASCII chars per page. If < 300 chars/page avg → PDF is scanned images.
3. **Choose OCR engine** in this priority order:
   - **Text layer present** → `pdftotext -layout` (fastest, free, lossless)
   - **Scanned + `OPENROUTER_API_KEY` set** → **Gemini 2.5 Flash via OpenRouter** — rasterizes each chunk at 200 DPI with `pdftoppm`, sends PNGs as vision input, Gemini returns verbatim Traditional Chinese markdown per page. Best quality for mixed CJK/English.
   - **Scanned + no OpenRouter key** → `ocrmypdf --force-ocr --language=chi_tra+eng` local fallback.
4. **Chunk** at 20 pages per chunk, writing `raw/handbooks/<slug>/page_NNN-NNN.md` with front-matter noting source + engine used.
5. Write `_manifest.json` with `{source_pdf, working_pdf, engine, chunks:[...]}`.
6. Invoke `ingest-claude` immediately (auto-chain).

Phase lines per SOUL (not verbatim copy — adapt counts):

```
▸ chunking <N> pages…
✓ <M> chunks → raw/handbooks/<slug>/
▸ Claude compiling…
✓ <K> pages → wiki/
```

## Implementation

Script: `./ingest.mjs`. Run via: `node ingest.mjs <pdf_path> [slug]`.

## Errors

- PDF not found → reply with path; ask the operator to re-upload.
- `pdftotext` missing → `brew install poppler`.
- `ocrmypdf` missing + scanned PDF → error: `PDF appears scanned but ocrmypdf not installed. Run: brew install ocrmypdf tesseract-lang`.
- Over 300 pages → per SOUL's cost-gate rule, confirm once: `確認: ingest <N>-page PDF? (~$<est>) y/n`
