// meeting-handlers — orchestrator for in-meeting actions (intro, greet+name-check,
// chat responder). Persists per-meeting state so it survives webhook restarts.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRoster, matchDisplayName, parseBniFormat } from "./roster-match.mjs";
import { sendChatMessage } from "./recall-chat.mjs";
import { generateChatReply as generateChatReplyClaude } from "./claude-responder.mjs";
import { generateChatReply as generateChatReplyOpenclaw } from "./llm-responder.mjs";
import { pickQuote } from "./quote-bank.mjs";
import { tryCachedAnswer } from "./qa-cache.mjs";

// Backend selection: default = Claude Haiku 4.5 via OpenRouter (fast + cheap).
// Set BNI_USE_OPENCLAW=1 to fall back to the legacy openclaw + GPT-5.4 path.
const USE_LEGACY_OPENCLAW = process.env.BNI_USE_OPENCLAW === "1";
const generateChatReply = USE_LEGACY_OPENCLAW ? generateChatReplyOpenclaw : generateChatReplyClaude;

const VAULT = "<vault-path>";

// Config (env-overridable)
const INTRO_TEXT = process.env.BNI_INTRO_MESSAGE ||
  "嗨，大家好 👋 我是 BNI Masta 🦁，<YourName>副主席的 AI 助理。";
const BNI_DAY = Number(process.env.BNI_MEETING_DAY || 5); // Friday = 5 (ISO Mon=1..Sun=7)
const BNI_HOUR_START = Number(process.env.BNI_WINDOW_HOUR_START || 6);
const BNI_HOUR_END = Number(process.env.BNI_WINDOW_HOUR_END || 8);
const BNI_MINUTE_START = Number(process.env.BNI_WINDOW_MINUTE_START || 45); // 06:45
const BNI_MINUTE_END = Number(process.env.BNI_WINDOW_MINUTE_END || 30);     // 07:30
// Cap on FREE-FORM replies (LLM answers + cheer quotes). Does NOT include
// mandatory procedural messages: join greet, rename nudges, visitor welcome,
// roll-call/點名 announcements, intro text — those bypass the counter.
const CHAT_REPLY_CAP = Number(process.env.BNI_CHAT_REPLY_CAP || 50);
// Single nudge per person — creator's decision after the 2026-04-24 meeting where
// many members got 2 nudges (too noisy). One try, then leave them alone.
const RENAME_NUDGE_CAP = Number(process.env.BNI_RENAME_NUDGE_CAP || 1);
const NAME_EXAMPLE = "01｜張大明｜商業保險";

// ---------- Taipei time Friday window check ----------
export function isInBniWindow(now = new Date()) {
  const tz = "Asia/Taipei";
  // Use Intl to get Taipei-local weekday+hour+minute
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const weekdayMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  const weekday = weekdayMap[parts.weekday];
  const h = Number(parts.hour), m = Number(parts.minute);
  if (weekday !== BNI_DAY) return false;
  const minutes = h * 60 + m;
  const start = BNI_HOUR_START * 60 + BNI_MINUTE_START;
  const end = BNI_HOUR_END * 60 + BNI_MINUTE_END;
  return minutes >= start && minutes <= end;
}

// ---------- per-meeting state persistence ----------
function stateFile(botId, date) {
  return join(VAULT, "raw/meetings", date, `${botId}.chat_state.json`);
}
function loadState(botId, date) {
  const p = stateFile(botId, date);
  if (!existsSync(p)) return {
    introPosted: false,
    freeFormResponseCount: 0,
    participants: {}, // keyed by participant_id
    lastReplyAt: 0,
  };
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return { introPosted: false, freeFormResponseCount: 0, participants: {}, lastReplyAt: 0 }; }
}
function saveState(botId, date, state) {
  const p = stateFile(botId, date);
  mkdirSync(join(VAULT, "raw/meetings", date), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}
// Discover a participant from ANY event (speech, webcam, chat, etc.) — if we've
// never greeted them, kick off the greet+name-check flow. This catches people
// who joined before the bot did (no join event fires for them from Recall).
export function tryDiscoverParticipant({ botId, date, participantId, displayName }) {
  if (!botId || !date || !participantId || !displayName) return;
  const state = loadState(botId, date);
  const ps = pstate(state, participantId);
  if (ps.greetedAt > 0) return; // already handled
  if (ps.welcomedAsMember || ps.welcomedAsVisitor || ps.visitorNudgeSent) return;
  // Fire the greet flow asynchronously; don't block the caller
  handleParticipantJoinOrRename({
    botId, date, participantId, displayName,
    isHost: false, isBotItself: false,
  }).catch(e => console.error(`[discover] ${e.message}`));
}

function pstate(state, pid) {
  if (!pid) return null;
  if (!state.participants[pid]) state.participants[pid] = {
    lastName: "",
    matchedMemberId: null,
    welcomedAsMember: false,
    welcomedAsVisitor: false,
    renameNudgesSent: 0,
    visitorNudgeSent: false,
    greetedAt: 0,
  };
  return state.participants[pid];
}

// Mark a participant as greeted (set greetedAt timestamp)
function markGreeted(state, pid) {
  const ps = pstate(state, pid);
  if (ps) ps.greetedAt = Date.now();
}

// ---------- greeting text ----------
// Self-intro is bundled into every joiner greet so visitors / new members
// always see who the bot is, even if they joined after the one-time intro.
const SELF_INTRO = "我是 BNI Masta 🦁，<YourName>副主席的 AI 助理";

function memberGreet(match) {
  const m = match.member;
  const thanksForFormat = match.bniFormat ? "（感謝使用標準格式 ✅）" : "";
  const thanksForAlias = (match.how === "exact_alias") ? "（感謝使用慣用名稱）" : "";
  return `👋 歡迎 ${m.name}！${SELF_INTRO}。今天一起 付出者收穫 💪 ${thanksForAlias}${thanksForFormat}`.trim();
}
function memberRenameNudge(displayName, _nthTime) {
  // Single nudge per person (RENAME_NUDGE_CAP=1). Short — no AI self-intro.
  // Just the format guidance + 代理人 hint.
  return `👋 ${displayName}：請把名字改為「編號｜姓名｜專業」格式（範例：${NAME_EXAMPLE}）。若是其他會員的代理人 → 在原會員名字後加「-代理人」`;
}
function renameThanks(memberName) {
  // Fires when someone who got nudged then renamed to a recognized format.
  return `🎉 謝謝 ${memberName} 改名！`;
}
function visitorNudge(displayName) {
  // Bot doesn't know if they're a visitor / member / substitute — show all 3.
  return `👋 歡迎 ${displayName}！${SELF_INTRO}。請依下列其中一種格式改名：
  • 來賓 → 「來賓｜${displayName}」
  • 會員 → 「編號｜姓名｜專業」格式（範例：${NAME_EXAMPLE}）
  • 代理人 → 在原會員名字後加上「-代理人」（範例：${NAME_EXAMPLE}-代理人）
（範例僅作格式示意，請填入您自己的編號／姓名／專業）`;
}
function visitorWelcome(displayName) {
  return `👋 歡迎來賓 ${displayName}！${SELF_INTRO}。很開心你來<YourChapter> 🌟`;
}

// ---------- handlers ----------

// Fetch participants that Recall already knows about for this bot. Handles
// the case where humans were in the meeting BEFORE the bot joined (Recall's
// participant_events.join only fires for post-bot arrivals, so we'd miss
// them otherwise).
async function fetchExistingParticipants(botId) {
  const API_KEY = process.env.VEXA_API_KEY;
  const REGION = process.env.VEXA_REGION || "ap-northeast-1";
  if (!API_KEY || !botId) return [];
  try {
    const r = await fetch(`https://${REGION}.vexa/api/v1/bot/${botId}/`, {
      headers: { authorization: `Token ${API_KEY}` },
    });
    if (!r.ok) return [];
    const bot = await r.json();
    // Try the live participant_events shortcut first
    const pe = bot.recordings?.[0]?.media_shortcuts?.participant_events?.data;
    if (pe?.participants_download_url) {
      try {
        const lr = await fetch(pe.participants_download_url);
        if (lr.ok) return await lr.json();
      } catch {}
    }
    return [];
  } catch { return []; }
}

// Send-readiness delay (ms). Recall/Zoom silently DROPS chat sends made within
// the first few seconds of the bot entering `in_call_recording` — the API
// returns HTTP 200 but the message never reaches the meeting chat.
// Confirmed in two live tests today: greet sent <1s after recording start was
// invisible; sends made 40-300s later were visible. 5000ms is a safe ceiling.
const SEND_WARMUP_MS = Number(process.env.BNI_SEND_WARMUP_MS || 5000);

// Block until at least SEND_WARMUP_MS have elapsed since the bot entered the
// recording state. Each meeting's chat_state stores `botRecordingStartedAt`
// so this works across webhook restarts (uses wall-clock, not in-memory timer).
async function waitForSendReadiness(botId, date) {
  const state = loadState(botId, date);
  const startedAt = state.botRecordingStartedAt;
  if (!startedAt) return; // unknown — fall through (best effort)
  const elapsed = Date.now() - startedAt;
  if (elapsed >= SEND_WARMUP_MS) return; // already past warmup
  const wait = SEND_WARMUP_MS - elapsed;
  console.log(`[meeting] ${botId} send-warmup: waiting ${wait}ms before first send`);
  await new Promise(r => setTimeout(r, wait));
}

// Called when the bot itself joins the call (first participant_events.join for bot).
// Posts the intro ONLY during the BNI window, then sweeps existing participants
// (people who were already in the meeting before the bot joined) and greets them.
export async function handleBotJoin({ botId, date }) {
  if (!botId || !date) return;
  const state = loadState(botId, date);
  // Stamp the recording-start time so subsequent sends can defer themselves
  // until the bot's chat capability is ready. Persisted so restart survives.
  if (!state.botRecordingStartedAt) {
    state.botRecordingStartedAt = Date.now();
    saveState(botId, date, state);
  }

  // 1. Intro (if it's Friday 06:45-07:30 Taipei)
  if (!state.introPosted) {
    if (!isInBniWindow()) {
      state.introPosted = true;
      console.log(`[meeting] ${botId} not in BNI window → no intro`);
    } else {
      await waitForSendReadiness(botId, date);
      try {
        await sendChatMessage(botId, INTRO_TEXT);
        state.introPosted = true;
        console.log(`[meeting] ${botId} intro posted`);
      } catch (e) { console.error(`[meeting] intro failed: ${e.message}`); }
    }
    saveState(botId, date, state);
  }

  // 2. Sweep existing participants — give Recall ~3s to populate participants_list
  //    then greet anyone who was already in the meeting.
  setTimeout(async () => {
    const list = await fetchExistingParticipants(botId);
    if (!list.length) {
      console.log(`[meeting] ${botId} no existing participants to sweep`);
      return;
    }
    console.log(`[meeting] ${botId} sweeping ${list.length} existing participants`);
    for (const p of list) {
      await handleParticipantJoinOrRename({
        botId, date,
        participantId: p.id ? String(p.id) : null,
        displayName: p.name || "",
        isHost: !!p.is_host,
        isBotItself: false, // the Recall API list excludes the bot itself
      });
    }
  }, 3000);

  // 3. Arm the 07:05 Friday roster announcement (one-shot, in-memory). On webhook
  //    restart this is lost — but maybePostRoster() called from event handlers
  //    will catch it whenever the next chat/join event arrives after 07:05.
  scheduleRosterAnnouncement(botId, date);
}

// ---------- Per-participant async lock ----------
//
// Zoom often fires `participant_events.join` + `participant_events.update`
// (rename) within ~50ms of a single human joining. Both are dispatched
// fire-and-forget by the webhook, so handleParticipantJoinOrRename runs
// CONCURRENTLY for the same participant. Without a lock, both calls:
//   1. loadState → both see ps.welcomedAsMember = false
//   2. enter the `if (!ps.welcomedAsMember)` block
//   3. await sendChatMessage  ← both succeed
//   4. saveState  ← second write wins; doesn't matter, harm already done
// Result: every greet + nudge ships TWICE.
//
// Fix: serialize calls per (botId, participantId). The next call for the
// same participant waits for the previous one to settle. The existing
// `if (!ps.welcomedAsMember)` guard then works correctly because the
// second call loads state AFTER the first one's saveState.
//
// Different participants (different keys) run in parallel — no contention.
// Lock is in-memory only; lost on webhook restart, which is fine because
// state-on-disk is the source of truth for what's already been sent.
const _participantLocks = new Map();
async function withParticipantLock(key, fn) {
  const prev = _participantLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _participantLocks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Free the slot only if no newer waiter has chained on top — otherwise
    // the chain would lose its anchor and a concurrent call would skip the
    // wait. The strict-equality check guards against that.
    if (_participantLocks.get(key) === next) _participantLocks.delete(key);
  }
}

// ---------- 07:05 Friday roster announcement ----------

const BNI_ROSTER_HOUR = Number(process.env.BNI_ROSTER_HOUR || 7);
const BNI_ROSTER_MINUTE = Number(process.env.BNI_ROSTER_MINUTE || 5);

// Returns ms until next 07:05 Taipei. If today is Friday and 07:05 hasn't
// passed → seconds-to-07:05. Otherwise → null (don't schedule).
function msUntilFridayRoster(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const wkMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  if (wkMap[parts.weekday] !== 5) return null; // not Friday
  const h = Number(parts.hour), m = Number(parts.minute), s = Number(parts.second);
  const nowSec = h * 3600 + m * 60 + s;
  const targetSec = BNI_ROSTER_HOUR * 3600 + BNI_ROSTER_MINUTE * 60;
  if (nowSec >= targetSec) return null; // already past
  return (targetSec - nowSec) * 1000;
}

function scheduleRosterAnnouncement(botId, date) {
  const delta = msUntilFridayRoster();
  if (delta == null) {
    console.log(`[roster] ${botId} not scheduled (not Friday or past 07:05)`);
    return;
  }
  console.log(`[roster] ${botId} scheduled for 07:05 Taipei in ${Math.round(delta / 1000)}s`);
  setTimeout(() => { postRosterAnnouncement(botId, date).catch(e => console.error(`[roster] post failed: ${e.message}`)); }, delta);
}

// Called from handleChatMessage + handleParticipantJoinOrRename — covers the
// case where the webhook restarted between bot.join and 07:05 (the in-memory
// setTimeout was lost).
async function maybePostRoster(botId, date) {
  if (!botId || !date) return;
  // Cheap gate: only attempt if we're inside the 07:05–07:15 Taipei window on a Friday.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei", weekday: "long",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  if (parts.weekday !== "Friday") return;
  const h = Number(parts.hour), m = Number(parts.minute);
  const minutes = h * 60 + m;
  const target = BNI_ROSTER_HOUR * 60 + BNI_ROSTER_MINUTE;
  if (minutes < target || minutes > target + 10) return; // not in 07:05–07:15 window
  const state = loadState(botId, date);
  if (state.rosterAnnouncedAt) return; // already done
  await postRosterAnnouncement(botId, date);
}

// Read all active members from wiki/members/*.md, sort, return numbered list.
function loadAllActiveMembers() {
  const dir = join(VAULT, "wiki/members");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(dir, f), "utf8");
      const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = {};
      for (const line of fmMatch[1].split("\n")) {
        const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (mm) fm[mm[1]] = mm[2].trim();
      }
      if (fm.status && fm.status !== "active") continue;
      const aliases = (fm.aliases || "").replace(/[\[\]"']/g, "").split(",").map(s => s.trim()).filter(Boolean);
      out.push({
        name: fm.name || f.replace(/\.md$/, ""),
        expertise: fm.expertise || "",
        aliases,
        index: fm.index ? Number(fm.index) : null, // not currently in YAML; future-proof
      });
    } catch {}
  }
  // Sort: by index if all have one, else alphabetical by name
  if (out.every(m => m.index != null)) out.sort((a, b) => a.index - b.index);
  else out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  return out;
}

function isVisitorName(name) {
  return /^\s*來賓[\s\|｜]/.test(String(name || ""));
}

// Build the formatted Zoom-chat roster announcement.
function buildRosterAnnouncement({ presentMembers, visitors, allMembers }) {
  const total = allMembers.length;
  const lines = [];
  lines.push("📋 出席統計（07:05）");
  lines.push("");

  lines.push(`✅ 出席會員（${presentMembers.length}／${total}）`);
  if (presentMembers.length === 0) {
    lines.push("（尚無會員到場）");
  } else {
    for (const m of presentMembers) {
      const idx = String(m._idx).padStart(2, "0");
      const exp = m.expertise || "—";
      lines.push(`${idx}｜${m.name}｜${exp}`);
    }
  }

  if (visitors.length) {
    lines.push("");
    lines.push(`👥 來賓（${visitors.length}）`);
    for (const v of visitors) lines.push(`• ${v}`);
  }

  const absent = allMembers.filter(m => !presentMembers.find(p => p.name === m.name));
  if (absent.length) {
    lines.push("");
    lines.push(`❌ 缺席（${absent.length}）`);
    // Cap absent list to avoid blowing past Zoom chat sensible length
    lines.push(absent.slice(0, 30).map(m => m.name).join("、") + (absent.length > 30 ? "…" : ""));
  }

  // 統計狀況 closing
  const pct = total > 0 ? Math.round((presentMembers.length / total) * 100) : 0;
  const standard = pct >= 80 ? "達 BNI 出席政策標準 ✅" : "未達 80% 標準 ⚠";
  lines.push("");
  lines.push(`📊 統計：出席率 ${pct}%（${presentMembers.length}／${total}）· 來賓 ${visitors.length} 位 · ${standard}`);
  return lines.join("\n");
}

async function postRosterAnnouncement(botId, date) {
  const state = loadState(botId, date);
  if (state.rosterAnnouncedAt) {
    console.log(`[roster] ${botId} already announced at ${new Date(state.rosterAnnouncedAt).toISOString()}, skipping`);
    return;
  }
  // Reserve the slot BEFORE async work to avoid double-fire if both setTimeout
  // and maybePostRoster trigger concurrently.
  state.rosterAnnouncedAt = Date.now();
  saveState(botId, date, state);

  const allMembers = loadAllActiveMembers();
  // Annotate with stable index for display
  allMembers.forEach((m, i) => { m._idx = m.index != null ? m.index : (i + 1); });

  const live = await fetchExistingParticipants(botId);
  const presentMembers = [];
  const visitors = [];
  for (const p of live) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    if (isVisitorName(name)) {
      visitors.push(name.replace(/^來賓[\s\|｜]+/, ""));
      continue;
    }
    // Match against members + aliases
    const member = allMembers.find(m =>
      m.name === name ||
      name.includes(m.name) ||
      m.aliases.some(a => a && new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(name))
    );
    if (member && !presentMembers.find(x => x.name === member.name)) presentMembers.push(member);
    else if (!member && !isVisitorName(name)) {
      // Unknown name — count as visitor but don't strip prefix
      if (!visitors.includes(name)) visitors.push(name);
    }
  }

  const msg = buildRosterAnnouncement({ presentMembers, visitors, allMembers });
  try {
    await sendChatMessage(botId, msg);
    console.log(`[roster] ${botId} posted (${presentMembers.length} present, ${visitors.length} visitors, ${allMembers.length - presentMembers.length} absent)`);
  } catch (e) {
    console.error(`[roster] ${botId} send failed: ${e.message}`);
    // Roll back the marker so a later retry can fire
    const s = loadState(botId, date);
    delete s.rosterAnnouncedAt;
    saveState(botId, date, s);
  }
}

// Called on each participant_events.join (not the bot itself) and participant_events.update (rename).
// Handles: welcome-if-new, name-check, rename nudges.
export async function handleParticipantJoinOrRename({ botId, date, participantId, displayName, isHost, isBotItself }) {
  if (!botId || !date || !participantId || isBotItself) return;
  // Catch-up the 07:05 roster post if the in-memory setTimeout was lost.
  // Fire-and-forget — outside the lock since it's about a separate concern.
  maybePostRoster(botId, date).catch(e => console.error(`[roster:catchup] ${e.message}`));

  // Serialize per-participant so back-to-back join+update events from Zoom
  // don't both pass the `if (!ps.welcomedAsMember)` guard concurrently and
  // double-send the greet + nudge. See _participantLocks comment above.
  return withParticipantLock(`${botId}:${participantId}`, async () => {
    // If this fires within the bot's first few seconds in the meeting,
    // Recall/Zoom drops the chat send silently. Wait until it's safe.
    await waitForSendReadiness(botId, date);

    const state = loadState(botId, date);
    const ps = pstate(state, participantId);
    const prevName = ps.lastName;
    const nameChanged = prevName !== displayName;
    ps.lastName = displayName;

    const match = matchDisplayName(displayName);

  // Case A: matched a member (exact or fuzzy)
  if (match.member) {
    // Already welcomed AND they just renamed to a recognized format → say thanks (only if they got nudged before)
    if (ps.welcomedAsMember && nameChanged && match.bniFormat && ps.renameNudgesSent > 0 && !ps.renameThanksSent) {
      try { await sendChatMessage(botId, renameThanks(match.member.name)); } catch (e) { console.error(e.message); }
      ps.renameThanksSent = true;
      saveState(botId, date, state);
      return;
    }
    // First time welcome for this member
    if (!ps.welcomedAsMember) {
      try { await sendChatMessage(botId, memberGreet(match)); } catch (e) { console.error(e.message); }
      ps.welcomedAsMember = true;
      ps.matchedMemberId = match.member.id;
      // Single nudge per person if their name isn't in a recognized BNI format.
      // (looksLikeBniFormat is lenient — accepts any "<number> ... <name> ..." mix.)
      if (!match.bniFormat && ps.renameNudgesSent < RENAME_NUDGE_CAP) {
        ps.renameNudgesSent += 1;
        try { await sendChatMessage(botId, memberRenameNudge(displayName)); }
        catch (e) { console.error(e.message); }
      }
      saveState(botId, date, state);
      return;
    }
    // Already welcomed but they just renamed to a bad format → bounded nudge (cap = 1)
    if (nameChanged && !match.bniFormat && ps.renameNudgesSent < RENAME_NUDGE_CAP) {
      ps.renameNudgesSent += 1;
      try { await sendChatMessage(botId, memberRenameNudge(displayName)); }
      catch (e) { console.error(e.message); }
      saveState(botId, date, state);
    }
    return;
  }

  // Case B: no member match — visitor, helper, or unrecognized
  // Helper convention (2026-04-25): display starts with "helper/" → non-chapter
  // member visiting to assist; counted in summary as Helper but no PALMS row.
  if (match.isHelper) {
    if (!ps.welcomedAsHelper) {
      const cleanName = displayName.replace(/^\s*(helper|協助|幫忙)[\s\|｜\/／\-:：]+/i, "");
      try { await sendChatMessage(botId, `🤝 歡迎 Helper ${cleanName}！感謝今天來分會幫忙 💛`); }
      catch (e) { console.error(e.message); }
      ps.welcomedAsHelper = true;
      saveState(botId, date, state);
    }
    return;
  }
  // If name starts with 來賓 → welcome as visitor, no nudge
  if (match.isVisitor) {
    if (!ps.welcomedAsVisitor) {
      try { await sendChatMessage(botId, visitorWelcome(displayName.replace(/^來賓[\s|｜]+/, ""))); }
      catch (e) { console.error(e.message); }
      ps.welcomedAsVisitor = true;
      saveState(botId, date, state);
    }
    return;
  }

  // Unrecognized name → send ONE nudge telling them to prefix 來賓 or use BNI format
  if (!ps.visitorNudgeSent) {
    try { await sendChatMessage(botId, visitorNudge(displayName)); }
    catch (e) { console.error(e.message); }
    ps.visitorNudgeSent = true;
    saveState(botId, date, state);
  }
  });  // ← end withParticipantLock callback
}

// Detect cheerful / positive chat that calls for an amplifying BNI quote.
// Does NOT require @-mention — bot can quietly cheer when others are cheering.
//
// 8 buckets, ~150 distinct triggers covering Chinese + English + Western
// emoticons + Unicode emoji + numerical praise (666/888) + agreement markers
// + BNI-specific affirmations.
function isCheerMoment(text) {
  if (!text) return false;
  const t = String(text);
  // 1. Numeric cheers (Chinese chat numerology). 666=cool, 888=lucky, 777=ok,
  //    999=long-lasting, 520=love, 1314=forever. Lookbehind/ahead so 1666
  //    (e.g. an address or amount) doesn't false-trigger.
  if (/(?<![0-9])(?:6{3,}|8{3,}|7{3,}|9{3,}|520|1314)(?![0-9])/.test(t)) return true;
  // 2. Chinese praise — long-form
  if (/太棒|太好|真好|真棒|很棒|超讚|大讚|讚啦|讚喔|讚耶|讚哦|讚爆|讚到|超強|超神|神級|神回|神操作|牛逼|牛批|很牛|超牛|屌爆|屌炸|很屌|超屌|厲害了|很厲害|超厲害|很強|超強|很高手|大神|大佬|大大|專業|棒極|帥|帥呆|帥爆|帥翻/.test(t)) return true;
  // 3. Chinese — content reactions ("learned a lot")
  if (/有道理|很有道理|滿滿乾貨|乾貨滿滿|受教|受教了|學到|學到了|學到很多|長知識|漲知識|秒懂|完美|無敵|頂級|頂到|實用|超實用|很實用|收穫|收穫滿滿|有收穫/.test(t)) return true;
  // 4. Greetings / thanks / encouragement
  if (/恭喜|感謝|謝謝|多謝|感激|致謝|加油|繼續加油/.test(t)) return true;
  if (/\bfighting\b/i.test(t)) return true;
  // 5. BNI-specific affirmation
  if (/付出者收穫|引薦|接住|傳承|分享得好|chapter|connection/i.test(t)) return true;
  // 6. Agreement markers
  if (/贊同|贊一個|很同意|同意|附議|沒錯|對的|是的|是啊|沒錯沒錯/.test(t)) return true;
  if (/(?<![A-Za-z0-9])\+1(?![0-9])/.test(t)) return true;
  // 7. ASCII / Western emoticons
  if (/(?::-?\)|:-?D|:-?\(|:'\)|;-?\)|XD|xd|\^_\^|\^\^|>w<|\(y\)|<3)/.test(t)) return true;
  // 8. Unicode emoji (celebration bucket — broad)
  if (/[💪🎉🔥✨🌟👏🙌💯🥳🎊❤️🧡💛💚💙💜🤍🌈☀️🥇🏆🚀💫⭐️🌸🍻🤝👍👌🆗💖💕😍🤩😎🥰🫶]/u.test(t)) return true;
  // 9. English praise (case-insensitive, word-bounded)
  if (/\b(thanks|thank ?you|thx|amazing|awesome|great|excellent|love it|bravo|congrats|brilliant|perfect|wonderful|fantastic|nice work|nice job|good job|impressive|outstanding|legendary|epic|sick|gg|wp|kudos|lit|fire|on point|spot on)\b/i.test(t)) return true;
  return false;
}

// Check whether a chat message mentions the bot (by "@" + various bot name shapes).
// This is the opt-in gate: without an @-mention, bot stays silent (no spam).
function mentionsBot(text) {
  if (!text) return false;
  const t = String(text);
  // Cover English + Chinese variants + the long Taiwan format originally configured
  const botNameShapes = [
    /@\s*BNI[\s\-_]?Masta/i,
    // TODO(template): add /@\s*BNI[\s\-_]?<YourSurnameUnicode>/i if you want @BNI <YourSurname> recognized
    // TODO(template): add a regex matching YOUR Chinese name so members
    // can @-mention you (the creator-specific pattern was removed).
    // /@\s*<YourChineseName>/,
    /@\s*BNI/i,                  // @BNI (anything starting with BNI)
    /@\s*bnimasta/i,             // @bnimasta handle-style
  ];
  for (const re of botNameShapes) if (re.test(t)) return true;
  return false;
}

// Called on public chat_message events.
// HARD RULE: only responds when bot is @-mentioned (so the bot doesn't spam).
// Question (in the mention) → LLM reply. Otherwise → instant BNI quote.
export async function handleChatMessage({ botId, date, participantId, displayName, text, isBotItself, isPrivate }) {
  if (!botId || !date || isBotItself) return;
  if (isPrivate) return; // HARD RULE: public chat only

  // Always discover participants from activity, regardless of whether we reply
  tryDiscoverParticipant({ botId, date, participantId, displayName });
  // Catch-up the 07:05 roster post if the in-memory setTimeout was lost
  maybePostRoster(botId, date).catch(e => console.error(`[roster:catchup] ${e.message}`));

  // Decide response mode:
  //   @-mention → LLM intelligent reply (contextual, reads the actual question)
  //   Cheer moment → quote bank (amplifies positive energy)
  //   Otherwise → silent
  const mode = mentionsBot(text) ? "llm" : (isCheerMoment(text) ? "quote" : "silent");
  if (mode === "silent") return;

  const state = loadState(botId, date);
  if (state.freeFormResponseCount >= CHAT_REPLY_CAP) return;
  const now = Date.now();
  if (now - state.lastReplyAt < 5000) return; // 5s min spacing

  state.recentQuotes = Array.isArray(state.recentQuotes) ? state.recentQuotes : [];
  let reply = "";
  if (mode === "llm") {
    // Strip the @-mention prefix so the LLM sees the actual question content
    const cleanText = String(text).replace(/@\s*BNI[\s\-_]?Masta[^\s]*\s*/i, "")
                                  // TODO(template): .replace(/@\s*BNI[\s\-_]?<YourSurname>[^\s]*\s*/i, "")
                                  // TODO(template): .replace(/@\s*<YourChineseFullName>\s*/, "")
                                  .replace(/@\s*BNI\s*/i, "")
                                  .replace(/@\s*bnimasta\s*/i, "")
                                  .trim();
    const q = cleanText || text;
    // FAST PATH: pre-computed Q&A from the vault. Replies in <100ms with no
    // LLM call when the question matches a known pattern (member count,
    // expertise lookup, rule lookup, next-meeting date, etc.).
    const cached = tryCachedAnswer(q);
    if (cached) {
      reply = cached.reply;
      console.log(`[qa-cache] hit (pattern=${cached.pattern}, elapsed=${cached.elapsedMs}ms)`);
    } else {
      // Cache miss → fall through to the LLM (Claude Haiku 4.5 by default).
      const r = generateChatReply(q, { sessionId: `chat-${botId}` });
      reply = (typeof r?.then === "function") ? await r : r;
    }
  } else {
    reply = pickQuote({ avoidSet: new Set(state.recentQuotes.slice(-8)) });
  }
  if (!reply) return;

  try { await sendChatMessage(botId, reply); }
  catch (e) { console.error(`[meeting] reply send failed: ${e.message}`); return; }

  state.freeFormResponseCount += 1;
  state.lastReplyAt = now;
  state.recentQuotes.push(reply);
  if (state.recentQuotes.length > 16) state.recentQuotes.shift();
  saveState(botId, date, state);
  console.log(`[meeting] ${botId} reply ${state.freeFormResponseCount}/${CHAT_REPLY_CAP} (${mode}) → ${displayName || participantId}`);
}
