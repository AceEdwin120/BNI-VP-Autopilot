#!/usr/bin/env node
// ai-news-deck — Stage 3 of the AI News Broadcaster.
//
// Takes the deduped Stage-2 scrape JSON, heuristically pre-ranks the posts,
// asks Claude Haiku in ONE call to pick the top 3 + write 繁中 summaries +
// generate 3 tips for <YourChapter> members, then renders a 6-page PDF deck via
// Chrome-headless (pattern vendored from skills/meeting-deck-report/deck.mjs).
//
// This script lives one level deeper than the parent BNI Masta autoload root
// (extensions/ai-news-broadcaster/skills/...), so the parent agent does NOT
// auto-pick it up. Invocation is by direct path or by the Stage 5 orchestrator.
//
// Usage:
//   node deck.mjs --input <scrape.json> --out-dir <dir>
//                 [--dry-run] [--top-n 3] [--no-render]
//
// Exit codes:
//   0   success — deck.html, curated.json (and deck.pdf unless --no-render/--dry-run) written
//   1   fatal error
//   2   bad CLI usage

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Pinned Haiku model (two namespaces: OpenRouter primary, Anthropic fallback) ──
// BNI Masta's existing pipelines (meeting-deck-report, detailed-meeting-report,
// claude-responder) all route Haiku via OpenRouter — this extension follows
// the same convention so a single OPENROUTER_API_KEY covers everything. The
// direct Anthropic SDK path remains as a fallback for portability when only
// ANTHROPIC_API_KEY is provisioned.
// If a future stage swaps models, change BOTH constants and update MANIFEST.md.
const OPENROUTER_MODEL = "anthropic/claude-haiku-4.5";        // BNI Masta convention (preferred)
const ANTHROPIC_MODEL  = "claude-haiku-4-5-20251001";          // direct Anthropic API fallback

// ── Paths ───────────────────────────────────────────────────────────────────
const EXTENSION_ROOT = resolve(__dirname, "..", "..");                   // extensions/ai-news-broadcaster
const SECRETS = process.env.BNI_SECRETS_FILE
  || "~/.openclaw/secrets/bni-masta.env";

// Vendored from skills/meeting-deck-report/deck.mjs:14 (read-only; not imported per MANIFEST policy).
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── Tiny env loader ─────────────────────────────────────────────────────────
// Vendored from skills/meeting-deck-report/deck.mjs:19-26 and skills/post-meeting-line-digest/digest.mjs
// (read-only; not imported per MANIFEST policy).
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
    input: null,
    outDir: null,
    dryRun: false,
    topN: 3,
    noRender: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-render") out.noRender = true;
    else if (a === "--input") out.input = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--top-n") out.topN = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.error(usage());
      process.exit(0);
    } else {
      console.error(`✗ unknown argument: ${a}\n`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!out.input) {
    console.error(`✗ --input <scrape.json> required`);
    console.error(usage());
    process.exit(2);
  }
  if (!out.outDir) {
    console.error(`✗ --out-dir <dir> required`);
    console.error(usage());
    process.exit(2);
  }
  if (!Number.isFinite(out.topN) || out.topN <= 0) {
    console.error(`✗ --top-n must be a positive number`);
    process.exit(2);
  }
  return out;
}

function usage() {
  return [
    "ai-news-deck — Haiku curate + 繁中 translate + Chrome PDF deck (Stage 3)",
    "",
    "Usage:",
    "  node deck.mjs --input <scrape.json> --out-dir <dir>",
    "                [--dry-run] [--top-n 3] [--no-render]",
    "",
    "Env:",
    "  OPENROUTER_API_KEY       preferred for live runs (BNI Masta convention)",
    "  ANTHROPIC_API_KEY        fallback for live runs (only used if OPENROUTER_API_KEY absent)",
    "  BNI_SECRETS_FILE         override secrets file path",
    "",
    "See ../../MANIFEST.md and ./SKILL.md for the full contract.",
  ].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function tierWeight(tier) {
  // Per Stage 3 spec — bumping 繁中 (C) above generic English media (B) since
  // they are more relevant to the chapter's audience. A=1.0, B=0.7, C=0.85.
  if (tier === "A") return 1.0;
  if (tier === "C") return 0.85;
  if (tier === "B") return 0.7;
  return 0.6;
}

function preRank(posts, sourcesById, nowMs, keepN = 15) {
  const scored = [];
  for (const p of posts) {
    const text = String(p?.text ?? "").trim();
    if (!text) continue;
    const eng = (p.engagement?.likes || 0)
      + 2 * (p.engagement?.comments || 0)
      + 3 * (p.engagement?.shares || 0);
    const engScore = Math.log10(1 + eng);
    const postedMs = p.posted_at ? Date.parse(p.posted_at) : NaN;
    let recency = 0;
    if (Number.isFinite(postedMs)) {
      const ageHours = Math.max(0, (nowMs - postedMs) / 3600000);
      // Linear decay 0..72h: 1.0 at posting time, 0 at 72h+.
      recency = Math.max(0, 1 - ageHours / 72);
    }
    const src = sourcesById[p.source_id] || {};
    const tier = src.tier || "B";
    const weight = tierWeight(tier);
    const score = engScore + recency + weight;
    scored.push({ post: p, score, tier, source: src });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, keepN);
}

// ── Anthropic call: ONE prompt, top-N + summaries + tips ────────────────────
function buildLLMPrompt(candidates, topN) {
  const compact = candidates.map((c, i) => {
    const p = c.post;
    return [
      `[${i + 1}] id=${p.id}`,
      `source=${p.source_id} tier=${c.tier}`,
      `posted_at=${p.posted_at || "unknown"}`,
      `url=${p.post_url}`,
      `text="""${clip(p.text, 1500)}"""`,
    ].join("\n");
  }).join("\n\n");

  return `你是 BNI <YourChapter> 分會的 AI 新聞編輯。會員是台灣中小企業主、業務、保險、地產、行銷、財顧、設計師等專業人士。

下面是過去 48 小時從各 AI 帳號擷取的 ${candidates.length} 則貼文候選。請：

(A) 從中選出 **最重要 / 最有趣的 ${topN} 則**。優先選新穎的（不是炒冷飯），偏重實際可用、對台灣中小企業主與業界專業人士有意義的內容；避免純 hype、純廣告、純 meme。如果可能，三則之間主題分散；但**如果候選總數少於 ${topN}，請選滿可用的全部，不要回傳空 items**。即使主題重疊或品質普通，也優先選滿；空清單只在候選為 0 時可接受。

(B) 為選中的每一則產生 **繁體中文（zh-TW，台灣用詞）** 的：
  - headline_zhTW: ≤30 字標題
  - summary_zhTW: **3-4 句完整摘要**（每句具體、有資訊量；避免單純複述標題；說清楚發生了什麼、誰做的、規模或數字、有什麼新意）
  - why_it_matters_zhTW: **1-2 句**「為什麼這值得各位夥伴關注」（從台灣中小企業主／業務／顧問角度；避免空泛口號）

(C) 為整批新聞產生 **3 條給各位夥伴的 tips（zh-TW 繁體）**。一條偏實務（試試 X 工具 / 這週可以做的事），一條偏策略（值得關注的趨勢 / 風向），一條由你判斷。每條 **≤65 字**，要具體，避免「擁抱 AI 浪潮」這類空話，也不要假設讀者已經會寫 prompt 或 API。語氣對所有夥伴（不只 BNI <YourChapter> 會員），讓任何台灣業界專業人士看了都覺得有用。

(D) 產生 **1 條互動 CTA（cta_zhTW）**，1-2 句，目的是引發群組成員留言討論。鎖定**這次選中的新聞主題**，從讀者角度提問（例如：「你會怎麼把它應用到 X 上？」、「你有試過 Y 嗎？感想？」、「這個趨勢你看好還是觀望？為什麼？」）。**避免**空泛問題（「大家覺得呢？」）、廣告式收尾、或假設讀者身份。語氣自然、像同行夥伴聊天，**≤80 字**。

請以下列 JSON 結構回傳，**只輸出 JSON**，不加 markdown code fence、不加任何前後說明：

{
  "items": [
    {
      "id": "<原始 post id>",
      "headline_zhTW": "...",
      "summary_zhTW": "...",
      "why_it_matters_zhTW": "...",
      "source_url": "<原始 post_url>",
      "posted_at": "<原 ISO 字串>",
      "tier": "A|B|C"
    }
  ],
  "tips_zhTW": ["...", "...", "..."],
  "cta_zhTW": "..."
}

語言規則：所有中文一律繁體（不要簡體），使用台灣常見用語（例如：軟體、影片、AI 模型、應用、廠商、業界、上線、公開、釋出、發表）。

<候選>
${compact}
</候選>`;
}

async function callAnthropic(prompt) {
  // Prefer OpenRouter — matches BNI Masta's existing Haiku call pattern across
  // meeting-deck-report / detailed-meeting-report / claude-responder. Set
  // BNI_AINEWS_FORCE_ANTHROPIC=1 to bypass and use the direct Anthropic SDK.
  const useOpenRouter = !!process.env.OPENROUTER_API_KEY
    && !process.env.BNI_AINEWS_FORCE_ANTHROPIC;

  let text;
  if (useOpenRouter) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 2400,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${resp.status}: ${body.slice(0, 240)}`);
    }
    const data = await resp.json();
    text = (data?.choices?.[0]?.message?.content || "").trim();
  } else {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2400,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });
    text = (resp.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
  }
  // Strip any code-fence wrapper just in case.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s < 0 || e < 0) {
    throw new Error(`LLM response did not contain JSON: ${text.slice(0, 240)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(s, e + 1));
  } catch (err) {
    throw new Error(`LLM JSON parse failed: ${err.message}; head=${cleaned.slice(0, 240)}`);
  }
  if (!parsed || !Array.isArray(parsed.items) || !Array.isArray(parsed.tips_zhTW)) {
    throw new Error(`LLM JSON missing items[] or tips_zhTW[]`);
  }
  // cta_zhTW added in v3 (interaction CTA). Tolerate older models that omit it.
  if (typeof parsed.cta_zhTW !== "string") {
    parsed.cta_zhTW = "";
  }
  return parsed;
}

// ── Dry-run sample (no API) ─────────────────────────────────────────────────
function sampleCuration(candidates, topN) {
  // Hand-coded fixture that exercises the same shape the LLM returns. We pick
  // the first topN candidates so the deck still references real posts.
  const items = candidates.slice(0, topN).map((c, i) => ({
    id: c.post.id,
    headline_zhTW: `[範例] <YourChapter> 趨勢 #${i + 1} — ${clip(c.source.name_zhTW || c.source.id || "未知來源", 14)}`,
    summary_zhTW: `這是 --dry-run 模式的繁體中文摘要佔位。實際運行會由 Claude Haiku 產生 2-3 句摘要，描述本則新聞的核心內容與重點。原文約 ${String(c.post.text || "").length} 字。`,
    why_it_matters_zhTW: `對各位夥伴而言，這代表一個可以在客戶對話或業務應用中切入的 AI 趨勢觀察點。`,
    source_url: c.post.post_url,
    posted_at: c.post.posted_at,
    tier: c.tier,
  }));
  return {
    items,
    tips_zhTW: [
      "本週花 15 分鐘體驗一個你還沒用過的 AI 工具，記下三個能用在自己業務上的場景。",
      "下次跟客戶聊天時，挑一則本期新聞當開場話題，觀察客戶的反應做為趨勢試水溫。",
      "把本期 deck 轉發給一位你覺得會有共鳴的會員，邀請對方下次分會聚會時一起討論。",
    ],
    cta_zhTW: "這幾則新聞裡，哪一個你最有興趣 / 最想試試看？歡迎留言聊聊你會怎麼用在自己的業務上。",
  };
}

// ── HTML deck template ──────────────────────────────────────────────────────
function buildDeckHtml({ runDate, runTimestamp, items, tips, totalCandidates }) {
  const itemSlides = items.map((it, idx) => {
    const tierBadge = it.tier ? `<span class="tier tier-${esc(it.tier)}">${esc(it.tier)}</span>` : "";
    return `
    <section class="slide item">
      <div class="slide-head">
        <span class="num">${idx + 1} / ${items.length}</span>
        ${tierBadge}
      </div>
      <h2 class="headline">${esc(it.headline_zhTW)}</h2>
      <div class="summary"><p>${esc(it.summary_zhTW)}</p></div>
      <div class="why">
        <div class="why-label">為什麼這對<YourChapter> 重要</div>
        <p>${esc(it.why_it_matters_zhTW)}</p>
      </div>
      <div class="source">
        <span class="src-label">來源</span>
        <a href="${esc(it.source_url)}">${esc(clip(it.source_url, 78))}</a>
        ${it.posted_at ? `<span class="src-date">· ${esc(String(it.posted_at).slice(0, 10))}</span>` : ""}
      </div>
    </section>`;
  }).join("\n");

  const tipsHtml = tips.map((t, i) => `
        <li class="tip">
          <span class="tip-num">${i + 1}</span>
          <span class="tip-text">${esc(t)}</span>
        </li>`).join("");

  const sourcesList = items.map((it, i) => `
        <li><span class="srcnum">${i + 1}.</span>
            <span class="srchead">${esc(clip(it.headline_zhTW, 30))}</span><br>
            <a href="${esc(it.source_url)}">${esc(it.source_url)}</a></li>`).join("");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI 趨勢快訊 ${esc(runDate)} · <YourChapter> BNI Masta</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:#f6f7fb;color:#1c2230;
            font-family:-apple-system,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;}
  .deck{width:100vw;}
  .slide{width:100vw;height:100vh;padding:7vh 7vw;display:flex;flex-direction:column;
         background:#ffffff;position:relative;overflow:hidden;}
  .slide + .slide{border-top:1px solid #e6e9ef;}
  .slide-head{display:flex;justify-content:space-between;align-items:center;
              color:#7a8597;font-size:14px;letter-spacing:.04em;margin-bottom:1.2rem;}
  .num{text-transform:uppercase}
  .tier{display:inline-block;background:#e9edf6;color:#1c2230;
        padding:.18rem .65rem;border-radius:999px;font-size:12px;font-weight:700;}
  .tier-A{background:#1c2230;color:#fff}
  .tier-B{background:#dfe3ec;color:#1c2230}
  .tier-C{background:#fff1d6;color:#7a4d00}

  /* Cover */
  .cover{justify-content:center;text-align:left;
         background:linear-gradient(160deg,#1c2230 0%,#2c3a5a 70%,#3b5070 100%);
         color:#f6f7fb;}
  .cover .kicker{font-size:14px;letter-spacing:.18em;color:#a8b6d8;margin-bottom:1.4rem;}
  .cover h1{font-size:clamp(40px,6.4vw,76px);font-weight:800;line-height:1.15;color:#fff;}
  .cover .sub{font-size:clamp(18px,2.4vw,26px);color:#d6dcec;margin-top:1.6rem;}
  .cover .ts{margin-top:auto;color:#7d8aaa;font-size:13px;letter-spacing:.06em;}

  /* Item slide */
  .headline{font-size:clamp(30px,4.4vw,52px);font-weight:800;line-height:1.25;
            color:#1c2230;margin-bottom:1.6rem;}
  .summary p{font-size:clamp(16px,1.8vw,21px);line-height:1.75;color:#36405a;}
  .why{margin-top:auto;background:#f1f4fb;border-left:5px solid #3057d4;
       padding:1.1rem 1.4rem;border-radius:6px;}
  .why-label{font-size:12px;letter-spacing:.16em;color:#3057d4;font-weight:700;
             text-transform:uppercase;margin-bottom:.4rem;}
  .why p{font-size:clamp(15px,1.7vw,19px);line-height:1.6;color:#1c2230;}
  .source{margin-top:1.2rem;font-size:13px;color:#5a6781;word-break:break-all;}
  .source .src-label{display:inline-block;background:#e9edf6;color:#1c2230;
                     padding:.1rem .55rem;border-radius:4px;margin-right:.5rem;font-weight:600;}
  .source a{color:#3057d4;text-decoration:none;}
  .src-date{margin-left:.5rem;color:#7a8597;}

  /* Tips slide */
  .tips h2{font-size:clamp(28px,3.6vw,44px);font-weight:800;color:#1c2230;
           margin-bottom:.6rem;}
  .tips .lede{color:#5a6781;font-size:clamp(15px,1.7vw,19px);margin-bottom:2rem;}
  .tips ol{list-style:none;display:flex;flex-direction:column;gap:1.2rem;}
  .tip{display:flex;gap:1.2rem;background:#fff;border:1px solid #e6e9ef;
       border-radius:12px;padding:1.2rem 1.4rem;align-items:flex-start;}
  .tip-num{flex:0 0 auto;width:34px;height:34px;border-radius:50%;
           background:#1c2230;color:#fff;display:flex;align-items:center;
           justify-content:center;font-weight:800;}
  .tip-text{font-size:clamp(15px,1.7vw,19px);line-height:1.65;color:#1c2230;flex:1;}

  /* Back-cover */
  .back h2{font-size:clamp(26px,3.4vw,40px);font-weight:800;color:#1c2230;
           margin-bottom:.4rem;}
  .back .lede{color:#5a6781;font-size:14px;margin-bottom:1.4rem;}
  .back ul{list-style:none;display:flex;flex-direction:column;gap:.8rem;
           font-size:14px;line-height:1.55;}
  .back li{padding:.6rem .8rem;background:#f1f4fb;border-radius:8px;}
  .srcnum{font-weight:700;color:#3057d4;margin-right:.4rem;}
  .srchead{color:#1c2230;}
  .back a{color:#3057d4;text-decoration:none;word-break:break-all;font-size:13px;}
  .footer{position:absolute;bottom:2.4vh;left:7vw;right:7vw;display:flex;
          justify-content:space-between;color:#7a8597;font-size:12px;
          border-top:1px solid #e6e9ef;padding-top:.6rem;}
  .cover .footer{color:#7d8aaa;border-top:1px solid rgba(255,255,255,.12);}

  @media print {
    html, body { background:#fff !important;
                 -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .deck { height: auto !important; }
    .slide {
      page-break-after: always; page-break-inside: avoid;
      width: 100% !important; height: 100vh !important;
    }
    .slide:last-child { page-break-after: auto; }
  }
  @page { size: 1280px 720px; margin: 0; }
</style>
</head>
<body>
<div class="deck">
  <section class="slide cover">
    <div class="kicker"><YourChapter> · BNI Masta</div>
    <h1>AI 趨勢快訊<br>${esc(runDate)}</h1>
    <div class="sub">本期精選 ${items.length} 則 AI 新聞 · 給 BNI <YourChapter> 夥伴的 ${tips.length} 個 tips</div>
    <div class="footer">
      <span>產生時間 ${esc(runTimestamp)}</span>
      <span>從 ${totalCandidates} 則候選貼文中精選</span>
    </div>
  </section>

  ${itemSlides}

  <section class="slide tips">
    <div class="slide-head"><span class="num">給各位夥伴的 ${tips.length} 個建議</span></div>
    <h2>給各位夥伴的 ${tips.length} 個建議</h2>
    <p class="lede">把本期 AI 新聞落地成下一週的具體動作。</p>
    <ol>${tipsHtml}
    </ol>
    <div class="footer">
      <span>${esc(runDate)} · <YourChapter> BNI Masta</span>
      <span>${esc(runTimestamp)}</span>
    </div>
  </section>

  <section class="slide back">
    <div class="slide-head"><span class="num">原文出處 / Sources</span></div>
    <h2>原文出處</h2>
    <p class="lede">想深入了解？以下是本期所有新聞的原始連結。</p>
    <ul>${sourcesList}
    </ul>
    <div class="footer">
      <span>${esc(runDate)} · <YourChapter> BNI Masta</span>
      <span>${esc(runTimestamp)}</span>
    </div>
  </section>
</div>
</body>
</html>`;
}

// ── Vendored Chrome-headless render ─────────────────────────────────────────
// Vendored from skills/meeting-deck-report/deck.mjs:427-435 (read-only;
// not imported per MANIFEST policy). Same Chrome path constant + same flags;
// kept independent so a fix in either file does not have to ripple.
function renderPdfViaChromeHeadless(htmlPath, pdfPath) {
  const res = spawnSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox",
    `--print-to-pdf=${pdfPath}`, "--print-to-pdf-no-header",
    "--virtual-time-budget=3000", `file://${htmlPath}`,
  ], { encoding: "utf8" });
  if (!existsSync(pdfPath)) {
    const err = (res.stderr || res.stdout || "(no stderr)").toString();
    throw new Error(`Chrome PDF render failed: ${err.slice(0, 400)}`);
  }
  return statSync(pdfPath).size;
}

// ── Core: runDeck(opts) ─────────────────────────────────────────────────────
// In-process entry point used by the Stage 5 orchestrator. Same work the CLI
// does, just structured as a function that takes a typed options object and
// returns a result object instead of writing the OK summary to stdout / calling
// process.exit on bad input. The CLI main() below is a thin shell over this.
//
// Throws Error on hard failures (input missing/malformed, missing API key in a
// non-dry-run, all posts empty, Chrome render failure, etc.).
//
// Returns:
//   { ok, summary, htmlPath, pdfPath, curatedPath, renderedPdf, pages,
//     candidatesIn, candidatesRanked, curated }
export async function runDeck({
  input,
  outDir,
  dryRun = false,
  topN = 3,
  noRender = false,
} = {}) {
  if (!input)  throw new Error(`runDeck: --input <scrape.json> required`);
  if (!outDir) throw new Error(`runDeck: --out-dir <dir> required`);
  if (!Number.isFinite(topN) || topN <= 0) {
    throw new Error(`runDeck: topN must be a positive number`);
  }

  if (!dryRun && !process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error([
      "Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set.",
      "  This skill prefers OPENROUTER_API_KEY (BNI Masta convention — matches the",
      "  meeting-deck-report / detailed-meeting-report / claude-responder pattern).",
      "  Set one in ~/.openclaw/secrets/bni-masta.env (see MANIFEST.md §6.2),",
      "  or run with --dry-run to use the hard-coded sample curation.",
    ].join("\n"));
  }

  // ── Load Stage-2 scrape JSON ──
  if (!existsSync(input)) {
    throw new Error(`input not found: ${input}`);
  }
  let scrape;
  try { scrape = JSON.parse(readFileSync(input, "utf8")); }
  catch (e) { throw new Error(`input malformed: ${e.message}`); }

  const posts = Array.isArray(scrape) ? scrape : (scrape.posts || []);
  const totalIn = posts.length;
  if (totalIn === 0) {
    throw new Error(`input has zero posts (nothing to curate)`);
  }

  // Build a source-id → tier map. Stage-2 output records source ids per post
  // but tier lives in config/sources.json — load that for tier weights.
  const sourcesPath = process.env.BNI_AINEWS_SOURCES_FILE
    || resolve(EXTENSION_ROOT, "config", "sources.json");
  let sourcesById = {};
  try {
    const raw = JSON.parse(readFileSync(sourcesPath, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.sources || []);
    for (const s of arr) sourcesById[s.id] = s;
  } catch (_) { /* tier defaults to B if sources file unreadable */ }

  // ── Pre-rank ──
  const candidates = preRank(posts, sourcesById, Date.now(), 15);
  if (candidates.length === 0) {
    throw new Error(`all ${totalIn} posts had empty text — no candidates`);
  }

  // ── LLM curation (or sample for dry-run) ──
  let curated;
  if (dryRun) {
    curated = sampleCuration(candidates, topN);
  } else {
    const prompt = buildLLMPrompt(candidates, topN);
    curated = await callAnthropic(prompt);
    // The LLM may return more or fewer than topN; trim to topN.
    curated.items = curated.items.slice(0, topN);
  }

  // Validate / fill in fields the curated payload should have. If the LLM
  // omitted a source_url we look it up from the candidate list by id.
  const candidatesById = Object.fromEntries(candidates.map(c => [c.post.id, c]));
  for (const it of curated.items) {
    if (!it.source_url && candidatesById[it.id]) it.source_url = candidatesById[it.id].post.post_url;
    if (!it.posted_at && candidatesById[it.id])  it.posted_at  = candidatesById[it.id].post.posted_at;
    if (!it.tier && candidatesById[it.id])       it.tier        = candidatesById[it.id].tier;
  }

  // ── Render ──
  mkdirSync(outDir, { recursive: true });

  const runDate = (scrape?.run?.date) || new Date().toISOString().slice(0, 10);
  const runTimestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const html = buildDeckHtml({
    runDate,
    runTimestamp,
    items: curated.items,
    tips: curated.tips_zhTW,
    totalCandidates: totalIn,
  });
  const htmlPath = join(outDir, "deck.html");
  const pdfPath  = join(outDir, "deck.pdf");
  const curatedPath = join(outDir, "curated.json");

  writeFileSync(htmlPath, html);
  writeFileSync(curatedPath, JSON.stringify({
    schema_version: 1,
    run: {
      date: runDate,
      generated_at: new Date().toISOString(),
      input,
      candidates_in: totalIn,
      candidates_ranked: candidates.length,
      top_n: topN,
      anthropic_model: dryRun ? null : ANTHROPIC_MODEL,
      dry_run: dryRun,
    },
    items: curated.items,
    tips_zhTW: curated.tips_zhTW,
  }, null, 2));

  const pages = 3 + curated.items.length;   // cover + items + tips + back-cover
  let renderedPdf = false;
  if (!dryRun && !noRender) {
    const size = renderPdfViaChromeHeadless(htmlPath, pdfPath);
    renderedPdf = true;
    // pages count is hard-coded in our template (cover + items + tips + back).
    void size;
  }

  return {
    ok: true,
    summary: `[ai-news-deck] OK — top ${curated.items.length} from ${totalIn} candidates, deck: ${renderedPdf ? pdfPath : htmlPath}, pages: ${pages}`,
    htmlPath,
    pdfPath,
    curatedPath,
    renderedPdf,
    pages,
    candidatesIn: totalIn,
    candidatesRanked: candidates.length,
    curated,
  };
}

// ── CLI shell ───────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const result = await runDeck({
    input: a.input,
    outDir: a.outDir,
    dryRun: a.dryRun,
    topN: a.topN,
    noRender: a.noRender,
  });
  console.log(result.summary);
}

// Only run the CLI when invoked directly. When the Stage 5 orchestrator
// imports runDeck, this guard keeps main() from auto-firing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(`✗ ${e.stack || e.message || e}`);
    process.exit(1);
  });
}
