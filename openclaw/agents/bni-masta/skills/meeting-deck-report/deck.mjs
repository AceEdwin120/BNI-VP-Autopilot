#!/usr/bin/env node
// meeting-deck-report — generates an HTML deck + PDF from <date>_detailed.md,
// uploads PDF to Google Drive, sends stats + Drive link to LINE. Friday-only.
//
// Usage: node deck.mjs <YYYY-MM-DD> <bot_id> [--force] [--no-line]

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const VAULT = "<vault-path>";
const SECRETS = "~/.openclaw/secrets/bni-masta.env";
const OPENCLAW_JSON = "~/.openclaw/openclaw.json";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DRIVE_ACCOUNT = process.env.BNI_ROSTER_ACCOUNT || "<your-google-account>";
const DRIVE_FOLDER_NAME = "BNI-Masta-Reports";
const HAIKU_MODEL = "anthropic/claude-haiku-4.5";

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const ln of readFileSync(p, "utf8").split("\n")) {
    const m = ln.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS);

// ---------- helpers ----------
function gog(args, opts = {}) {
  const r = spawnSync("gog", args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`gog ${args.slice(0,3).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function getLineToken() {
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  try { return JSON.parse(readFileSync(OPENCLAW_JSON, "utf8")).channels?.line?.channelAccessToken || null; }
  catch { return null; }
}
function getAlexLineId() {
  if (process.env.ALEX_LINE_ID) return process.env.ALEX_LINE_ID;
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_JSON, "utf8"));
    const allow = cfg.channels?.line?.allowFrom || [];
    return allow.find(x => /^U[a-f0-9]{32}$/.test(x)) || "<your-line-user-id>";
  } catch { return "<your-line-user-id>"; }
}
function fmGet(s, k) { return (s.match(new RegExp(`^${k}:\\s*(.*)$`, "m")) || [, ""])[1].trim(); }
function fmList(s, k) {
  const m = s.match(new RegExp(`^${k}:\\s*\\[(.*)\\]$`, "m"));
  return m ? m[1].split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
}
function isFridayDate(dateStr) {
  return new Date(`${dateStr}T12:00:00+08:00`).getUTCDay() === 5;
}
function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ---------- Haiku calls ----------
async function haikuCall(prompt, maxTokens = 800) {
  if (!process.env.OPENROUTER_API_KEY) return "";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://github.com/<your-github>/<your-repo>",
        "X-Title": "BNI-Masta deck",
      },
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: maxTokens, temperature: 0.2,
        messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return (j?.choices?.[0]?.message?.content || "").trim();
  } catch { return ""; }
}
async function clusterTopics(members) {
  const compact = members.map(m => `${m.idx} ${m.name}: ${m.bullets[0] || "(無)"}`).join("\n");
  const prompt = `以下是 BNI <YourChapter>分會今天例會中 ${members.length} 位會員的個人重點。請分成 3-5 個主題群組，每組請輸出 JSON 物件：
{ "name": "主題名稱(短)", "desc": "一句話描述(≤25字)", "members": ["編號1","編號2",...] }

只輸出一個 JSON 陣列（不加 markdown code fence、不加任何前後說明）。

<會員摘要>
${compact}
</會員摘要>`;
  const txt = (await haikuCall(prompt)).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const s = txt.indexOf("["), e = txt.lastIndexOf("]");
  if (s < 0 || e < 0) return [];
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return []; }
}
async function extractActions(members) {
  const compact = members.map(m => `${m.idx} ${m.name}: ${m.bullets.join("; ")}`).join("\n");
  const prompt = `以下是 BNI <YourChapter>分會例會的會員重點。找出明確的 **行動項目 / 待辦 / 下週要做的事**。每行繁體中文，格式：「[負責人 編號] 行動」。最多 8 項。沒有則回 NONE。

<摘要>
${compact}
</摘要>`;
  const txt = await haikuCall(prompt, 600);
  if (/^NONE\b/i.test(txt)) return [];
  return txt.split("\n").map(s => s.trim()).filter(s => s && !/^NONE/i.test(s));
}

// ---------- HTML deck builder ----------
function buildDeckHtml({ date, stats, members, themes, actions, absentMembers, visitors, helpers }) {
  const memberByIdx = Object.fromEntries(members.map(m => [m.idx, m]));
  const themesHtml = themes.length ? `
    <div class="theme-grid">
      ${themes.map(t => `
        <div class="theme-card">
          <h3 class="theme-name">${esc(t.name)}</h3>
          <p class="theme-desc">${esc(t.desc || "")}</p>
          <div class="theme-members">
            ${(t.members || []).map(idx => {
              const norm = String(idx).padStart(3, "0");
              const m = memberByIdx[norm] || memberByIdx[String(idx)];
              return `<span class="chip">${esc(idx)} ${esc(m?.name || "")}</span>`;
            }).join("")}
          </div>
        </div>
      `).join("")}
    </div>` : `<p class="empty">主題分群暫不可用</p>`;

  const CARDS_PER_SLIDE = 6;
  const groups = [];
  for (let i = 0; i < members.length; i += CARDS_PER_SLIDE) groups.push(members.slice(i, i + CARDS_PER_SLIDE));
  const memberSlides = groups.map((group, gi) => `
    <section class="slide">
      <h2>各位重點 <span class="meta">${gi + 1}/${groups.length}</span></h2>
      <div class="card-grid">
        ${group.map(m => `
          <div class="card">
            <div class="card-head"><span class="idx">${esc(m.idx)}</span> <span class="name">${esc(m.name)}</span></div>
            <ul class="bullets">
              ${m.bullets.length ? m.bullets.slice(0, 3).map(b => `<li>${esc(b)}</li>`).join("") : `<li class="empty">（無發言）</li>`}
            </ul>
          </div>
        `).join("")}
      </div>
    </section>`).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title><YourChapter> ${date} 例會報告</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:#0b1220;color:#e7eef9;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;overflow:hidden}
  .deck{width:100vw;height:100vh;position:relative}
  .slide{width:100vw;height:100vh;padding:5vh 6vw 10vh;position:absolute;inset:0;
         opacity:0;transform:translateY(20px);transition:opacity .35s ease,transform .35s ease;
         display:flex;flex-direction:column;pointer-events:none;overflow-y:auto;overflow-x:hidden}
  .slide.active{opacity:1;transform:translateY(0);pointer-events:auto}
  .slide::-webkit-scrollbar{width:8px}
  .slide::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}
  @media (prefers-reduced-motion:reduce){.slide{transition:none}}
  h1{font-size:clamp(28px,5vw,56px);font-weight:800;color:#fff;margin-bottom:.8rem}
  h2{font-size:clamp(22px,3.2vw,36px);font-weight:700;color:#fff;margin-bottom:1.2rem;border-left:6px solid #f5b400;padding-left:.8rem;flex-shrink:0}
  p{font-size:clamp(14px,1.6vw,17px);line-height:1.6;color:#c8d3e6;margin:.3rem 0}
  .meta{font-size:.55em;color:#6b7a99;font-weight:normal}
  .cover{justify-content:center;align-items:center;text-align:center;background:radial-gradient(ellipse at top,#1c2c4f,#0b1220);overflow:hidden}
  .cover h1{font-size:clamp(40px,7vw,80px)}
  .cover .subtitle{font-size:clamp(18px,2.6vw,28px);color:#f5b400;margin-top:.6rem}
  .cover .lion{font-size:80px;margin:1rem 0}
  .cover .footer{position:absolute;bottom:4vh;color:#6b7a99;font-size:13px}
  .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem;margin-top:1rem}
  .stat{background:rgba(255,255,255,.05);border-radius:14px;padding:1.3rem;border-left:4px solid #f5b400}
  .stat .label{color:#8aa0c5;font-size:13px;text-transform:uppercase;letter-spacing:1px}
  .stat .value{color:#fff;font-size:clamp(32px,5vw,56px);font-weight:800;line-height:1;margin:.3rem 0}
  .stat .delta{color:#8aa0c5;font-size:12px}
  .stat.hero{grid-column:span 3;background:linear-gradient(135deg,#f5b400 0,#ff7e1d 100%);border-left:none}
  .stat.hero .label,.stat.hero .delta{color:rgba(0,0,0,.7)}
  .stat.hero .value{color:#0b1220;font-size:clamp(44px,7vw,76px)}
  .theme-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:.5rem}
  .theme-card{background:rgba(255,255,255,.05);border-radius:12px;padding:1.1rem 1.3rem;border-left:4px solid #f5b400}
  .theme-name{color:#f5b400;font-size:clamp(16px,1.9vw,20px);font-weight:700;margin-bottom:.3rem}
  .theme-desc{color:#c8d3e6;font-size:13px;margin-bottom:.6rem;font-style:italic}
  .theme-members{display:flex;flex-wrap:wrap;gap:.4rem}
  .chip{background:rgba(245,180,0,.15);color:#f5e0a0;padding:.2rem .55rem;border-radius:6px;font-size:12px;border:1px solid rgba(245,180,0,.3)}
  .card-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;align-content:start}
  .card{background:rgba(255,255,255,.05);border-radius:10px;padding:.9rem 1.1rem;border-left:3px solid #38bdf8}
  .card-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem}
  .idx{background:#f5b400;color:#0b1220;padding:.15rem .45rem;border-radius:5px;font-weight:700;font-size:12px;min-width:34px;text-align:center}
  .name{color:#fff;font-weight:600;font-size:16px}
  .bullets{list-style:none}
  .bullets li{color:#c8d3e6;font-size:13px;line-height:1.5;padding:.1rem 0 .1rem .9rem;position:relative}
  .bullets li::before{content:"•";position:absolute;left:0;color:#f5b400}
  .bullets .empty,.empty{color:#6b7a99;font-style:italic}
  .list-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem 1.2rem;margin-top:.8rem}
  .list-grid .item{background:rgba(255,255,255,.05);padding:.5rem .9rem;border-radius:8px;color:#c8d3e6;font-size:14px}
  .section-title{color:#f5b400;font-size:18px;font-weight:600;margin:1.2rem 0 .3rem;border-left:4px solid #f5b400;padding-left:.6rem}
  .action{display:flex;gap:.7rem;padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.08)}
  .action:last-child{border-bottom:none}
  .action .marker{color:#f5b400;font-size:18px}
  .action .text{color:#c8d3e6;font-size:15px;line-height:1.5}
  .ctrl{position:fixed;bottom:2vh;left:50%;transform:translateX(-50%);display:flex;gap:1rem;z-index:10;
        background:rgba(0,0,0,.5);padding:.5rem 1.1rem;border-radius:999px;backdrop-filter:blur(8px)}
  .ctrl button{background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:.25rem .7rem;border-radius:6px}
  .ctrl button:hover{background:rgba(255,255,255,.1)}
  .ctrl .num{color:#8aa0c5;font-size:13px;padding:.25rem .5rem}
  @media print {
    html, body { overflow: visible !important; height: auto !important; background: #0b1220 !important;
                 -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .deck { height: auto !important; }
    .slide {
      position: relative !important; inset: auto !important;
      width: 100% !important; height: 100vh !important; max-height: 100vh !important;
      opacity: 1 !important; transform: none !important; transition: none !important;
      page-break-after: always; page-break-inside: avoid;
      overflow: hidden !important; pointer-events: auto !important;
    }
    .slide:last-child { page-break-after: auto; }
    .ctrl { display: none !important; }
  }
  @page { size: 1280px 720px; margin: 0; }
</style>
</head>
<body>
<div class="deck" id="deck">
  <section class="slide cover">
    <div class="lion">🦁</div>
    <h1><YourChapter></h1>
    <div class="subtitle">${esc(date)} 週五例會 · 詳細報告</div>
    <div class="footer">由 BNI Masta 自動生成</div>
  </section>
  <section class="slide">
    <h2>📊 出席統計</h2>
    <div class="stat-grid">
      <div class="stat hero">
        <div class="label">實到 / 應到</div>
        <div class="value">${stats.present}<span style="font-size:.5em;color:rgba(0,0,0,.5)"> / ${stats.expected}</span></div>
        <div class="delta">出席率 ${Math.round((Number(stats.present)/Number(stats.expected))*100)}%</div>
      </div>
      <div class="stat"><div class="label">全程</div><div class="value">${stats.full}</div><div class="delta">07:05 前到</div></div>
      <div class="stat"><div class="label">遲到</div><div class="value">${stats.late}</div><div class="delta">07:05 後到</div></div>
      <div class="stat"><div class="label">早退</div><div class="value">${stats.early}</div><div class="delta">提前離開</div></div>
      <div class="stat"><div class="label">代理</div><div class="value">${stats.sub}</div><div class="delta">會員代理人</div></div>
      <div class="stat"><div class="label">缺席</div><div class="value">${stats.absent}</div><div class="delta">未出席</div></div>
      <div class="stat"><div class="label">來賓</div><div class="value">${stats.visitor}</div><div class="delta">visitors</div></div>
    </div>
  </section>
  <section class="slide">
    <h2>🎯 主要議題群組</h2>
    ${themesHtml}
  </section>
  ${memberSlides}
  <section class="slide">
    <h2>❌ 缺席 / 👥 來賓 / 🤝 Helper</h2>
    <div class="section-title">缺席 (${absentMembers.length})</div>
    <div class="list-grid">${absentMembers.map(n => `<div class="item">${esc(n)}</div>`).join("")}</div>
    <div class="section-title">來賓 (${visitors.length})</div>
    <div class="list-grid">${visitors.map(v => `<div class="item">${esc(v)}</div>`).join("")}</div>
    <div class="section-title">Helper (${helpers.length})</div>
    <div class="list-grid">${helpers.map(h => `<div class="item">${esc(h)}</div>`).join("")}</div>
  </section>
  <section class="slide">
    <h2>✅ 行動項目 (Haiku 自動萃取)</h2>
    <div>${actions.length ? actions.map(a => `<div class="action"><div class="marker">▸</div><div class="text">${esc(a)}</div></div>`).join("") : `<p class="empty">本次例會 Haiku 未萃取出明顯行動項目（多為個人專業介紹與週報分享）。</p>`}</div>
  </section>
  <section class="slide cover">
    <h1 style="font-size:60px">付出者 收穫 💪</h1>
    <div class="subtitle">下週五 06:45 見</div>
    <div class="footer">${esc(date)} 例會 · 報告結束</div>
  </section>
</div>
<div class="ctrl">
  <button onclick="prev()" aria-label="prev">←</button>
  <span class="num" id="num">1 / 1</span>
  <button onclick="next()" aria-label="next">→</button>
</div>
<script>
const slides=document.querySelectorAll(".slide");let idx=0;
function show(i){idx=Math.max(0,Math.min(slides.length-1,i));slides.forEach((s,n)=>s.classList.toggle("active",n===idx));document.getElementById("num").textContent=(idx+1)+" / "+slides.length;slides[idx].scrollTop=0;}
function next(){show(idx+1)}function prev(){show(idx-1)}
document.addEventListener("keydown",e=>{if(e.key==="ArrowRight"||e.key===" "||e.key==="PageDown")next();if(e.key==="ArrowLeft"||e.key==="PageUp")prev();if(e.key==="Home")show(0);if(e.key==="End")show(slides.length-1)});
show(0);
</script>
</body>
</html>`;
}

// ---------- Drive helpers ----------
function ensureDriveFolder() {
  // Check if folder exists; if not, create it.
  const search = gog(["drive", "search", `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                       "--account", DRIVE_ACCOUNT, "--json"], { allowFail: true });
  try {
    const j = JSON.parse(search);
    const files = j.files || j.results || [];
    if (files.length > 0) return files[0].id;
  } catch {}
  // Create folder
  const create = gog(["drive", "create-folder", DRIVE_FOLDER_NAME, "--account", DRIVE_ACCOUNT, "--json"], { allowFail: true });
  try {
    const j = JSON.parse(create);
    return j.file?.id || j.id;
  } catch (e) { return null; }
}
function uploadAndShare(localPath, displayName) {
  const folderId = ensureDriveFolder();
  const args = ["drive", "upload", localPath, "--name", displayName, "--account", DRIVE_ACCOUNT, "--json"];
  if (folderId) args.push("--parent", folderId);
  const upOut = gog(args);
  const j = JSON.parse(upOut);
  const fileId = j.file?.id || j.id;
  if (!fileId) throw new Error("Drive upload returned no file id");
  // Share as anyone-reader
  gog(["drive", "share", fileId, "--to", "anyone", "--role", "reader", "--account", DRIVE_ACCOUNT, "--force"]);
  return { fileId, url: `https://drive.google.com/file/d/${fileId}/view` };
}

// ---------- LINE push ----------
// Targets: operator's userId always, plus any groupIds in env var
// BNI_DECK_LINE_GROUP_IDS (comma-separated, original-case `C`+32hex). Each
// target gets the full bundle of messages. Failures on one target do not
// abort the others (partial-success is fine — operator critical, groups optional).
function getLineTargets() {
  const targets = [];
  const userId = getAlexLineId();
  if (userId) targets.push({ kind: "user", id: userId });
  const groupCsv = process.env.BNI_DECK_LINE_GROUP_IDS || "";
  for (const raw of groupCsv.split(",").map(s => s.trim()).filter(Boolean)) {
    targets.push({ kind: "group", id: raw });
  }
  return targets;
}
async function pushTo(token, target, messages) {
  for (let i = 0; i < messages.length; i += 5) {
    const batch = messages.slice(i, i + 5);
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: target.id, messages: batch }),
    });
    if (!r.ok) throw new Error(`LINE ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await new Promise(res => setTimeout(res, 300));
  }
}
async function lineMessages(messages) {
  const token = getLineToken();
  if (!token) throw new Error("missing LINE token");
  const targets = getLineTargets();
  if (!targets.length) throw new Error("no LINE targets resolved");
  const results = [];
  for (const t of targets) {
    try {
      await pushTo(token, t, messages);
      console.log(`  ✓ LINE → ${t.kind}:${t.id.slice(0, 12)}…`);
      results.push({ target: t, ok: true });
    } catch (e) {
      console.error(`  ✗ LINE → ${t.kind}:${t.id.slice(0, 12)}… FAILED: ${e.message}`);
      results.push({ target: t, ok: false, error: e.message });
    }
  }
  // Throw only if EVERY target failed — partial success is acceptable
  if (results.every(r => !r.ok)) throw new Error("all LINE targets failed");
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const botId = args.find(a => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(a));
  const force = args.includes("--force");
  const noLine = args.includes("--no-line");
  if (!date || !botId) {
    console.error("usage: deck.mjs <YYYY-MM-DD> <bot_id> [--force] [--no-line]");
    process.exit(2);
  }
  const meetingDir = join(VAULT, "raw/meetings", date);
  const marker = join(meetingDir, `${botId}.deck_done`);
  if (existsSync(marker) && !force) { console.log("⚠ deck already processed (use --force)"); process.exit(0); }
  if (!force && !isFridayDate(date)) {
    console.log(`⚠ ${date} is not a Friday — deck skipped`);
    writeFileSync(marker, JSON.stringify({ skipped: "not_friday", at: new Date().toISOString() }));
    process.exit(0);
  }
  // Test-meeting skip (read meeting page if exists)
  const meetingPage = join(VAULT, "wiki/meetings", `${date}.md`);
  if (existsSync(meetingPage) && !force) {
    const mp = readFileSync(meetingPage, "utf8");
    if (/^test:\s*true$/m.test(mp) || /^excluded_from_scoring:\s*true$/m.test(mp)) {
      console.log("⚠ test meeting — deck skipped");
      writeFileSync(marker, JSON.stringify({ skipped: "test_meeting", at: new Date().toISOString() }));
      process.exit(0);
    }
  }

  const detailedPath = join(VAULT, "wiki/meeting_reports", `${date}_detailed.md`);
  const rcPath = join(VAULT, "raw/roll_calls", `${date}.md`);
  if (!existsSync(detailedPath)) { console.error(`✗ no ${detailedPath}`); process.exit(1); }
  if (!existsSync(rcPath)) { console.error(`✗ no ${rcPath}`); process.exit(1); }

  const detailed = readFileSync(detailedPath, "utf8");
  const rc = readFileSync(rcPath, "utf8");

  const stats = { expected: fmGet(rc, "expected_count"), present: fmGet(rc, "present_count"),
    full: fmGet(rc, "present_full"), late: fmGet(rc, "late_count"), early: fmGet(rc, "early_leave_count"),
    sub: fmGet(rc, "substitute_count"), absent: fmGet(rc, "absent_count"),
    visitor: fmGet(rc, "visitor_count"), helper: fmGet(rc, "helper_count") };
  const absentMembers = fmList(rc, "absent_members");
  const visitors = fmList(rc, "visitors");
  const helpers = fmList(rc, "helpers");

  const members = [];
  for (const sec of detailed.split(/(?=^### )/m)) {
    const head = sec.match(/^### (\d+)\s+(\S+)/);
    if (!head) continue;
    const block = sec.match(/\*\*發言重點 \(Haiku 摘要\)\*\*：\s*\n((?:\s+•[^\n]*\n)+)/);
    const bullets = block ? [...block[1].matchAll(/•\s*(.+)/g)].map(m => m[1].trim()).slice(0, 3) : [];
    members.push({ idx: head[1], name: head[2], bullets });
  }

  console.log(`▸ Haiku clustering + actions (${members.length} members)…`);
  const [themes, actions] = await Promise.all([clusterTopics(members), extractActions(members)]);
  console.log(`✓ ${themes.length} themes, ${actions.length} actions`);

  const html = buildDeckHtml({ date, stats, members, themes, actions, absentMembers, visitors, helpers });
  const htmlPath = join(VAULT, "wiki/meeting_reports", `${date}_deck.html`);
  const pdfPath = join(VAULT, "wiki/meeting_reports", `${date}_deck.pdf`);
  mkdirSync(join(VAULT, "wiki/meeting_reports"), { recursive: true });
  writeFileSync(htmlPath, html);
  console.log(`✓ wrote ${htmlPath}`);

  console.log(`▸ rendering PDF via Chrome headless…`);
  const chromeRes = spawnSync(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox",
    `--print-to-pdf=${pdfPath}`, "--print-to-pdf-no-header",
    "--virtual-time-budget=3000", `file://${htmlPath}`,
  ], { encoding: "utf8" });
  if (!existsSync(pdfPath)) { console.error(`✗ Chrome PDF failed: ${chromeRes.stderr}`); process.exit(1); }
  const pdfSize = statSync(pdfPath).size;
  console.log(`✓ wrote ${pdfPath} (${Math.round(pdfSize/1024)} KB)`);

  console.log(`▸ uploading PDF to Google Drive (${DRIVE_FOLDER_NAME})…`);
  let driveUrl = "";
  try {
    const { fileId, url } = uploadAndShare(pdfPath, `${date}_<YourChapter>例會報告.pdf`);
    driveUrl = url;
    console.log(`✓ uploaded fileId=${fileId} url=${url}`);
  } catch (e) {
    console.error(`✗ Drive upload failed: ${e.message}`);
    // still write marker (deck files are saved); just don't send LINE
    writeFileSync(marker, JSON.stringify({ partial: true, error: e.message, at: new Date().toISOString() }));
    process.exit(1);
  }

  if (noLine) {
    console.log("⏭ --no-line — skipping LINE push");
    writeFileSync(marker, JSON.stringify({ done: true, no_line: true, at: new Date().toISOString(),
      driveUrl, htmlPath, pdfPath }));
    return;
  }

  // Build the LINE messages
  const statsMsg = [
    `📊 <YourChapter> ${date} 例會總結`,
    "",
    `應到 ${stats.expected} / 實到 ${stats.present} / 全程 ${stats.full} / 遲到 ${stats.late} / 早退 ${stats.early} / 缺席 ${stats.absent} / 來賓 ${stats.visitor} / Helper ${stats.helper}`,
    "",
    absentMembers.length ? `❌ 缺席 (${absentMembers.length}): ${absentMembers.join("、")}` : null,
    visitors.length ? `👥 來賓 (${visitors.length}): ${visitors.map(v => v.split("/").pop() || v).join("、")}` : null,
    helpers.length ? `🤝 Helper (${helpers.length}): ${helpers.map(h => h.split("/").shift() || h).join("、")}` : null,
  ].filter(Boolean).join("\n");

  const linkMsg = `📎 完整報告 (PDF):\n${driveUrl}`;

  const targetCount = getLineTargets().length;
  console.log(`▸ pushing 2 LINE messages × ${targetCount} target(s)…`);
  await lineMessages([
    { type: "text", text: statsMsg.slice(0, 4900) },
    { type: "text", text: linkMsg.slice(0, 4900) },
  ]);
  console.log(`✓ LINE messages sent to all targets`);

  writeFileSync(marker, JSON.stringify({ done: true, at: new Date().toISOString(),
    driveUrl, htmlPath, pdfPath }));
  console.log(`✓ deck-report done`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
