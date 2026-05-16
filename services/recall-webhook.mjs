#!/usr/bin/env node
// recall-webhook — receive Recall.ai realtime_endpoints events and persist them.
//
// Events we care about (per Recall.ai docs):
//   - participant_events.join | leave | update | speech_on | speech_off |
//     webcam_on | webcam_off | chat_message
//   - transcript.data
//
// Auth: if RECALL_WEBHOOK_TOKEN is set, we require ?token=<same> on every POST.
// (The whsec_... HMAC secret Recall.ai gives is for account-level webhooks, which
// we don't use yet — so we rely on the query-string token instead.)
//
// On each event:
//   - append one line to raw/meetings/<date>/participants.jsonl (normalized shape)
//   - append transcript lines to raw/meetings/<date>/transcript.jsonl
//
// We don't run resolve-attendance here — that's meeting-poll's job (it detects
// bot.done via polling since realtime webhooks don't emit bot status changes).

import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  handleBotJoin, handleParticipantJoinOrRename, handleChatMessage,
  tryDiscoverParticipant,
} from "./lib/meeting-handlers.mjs";
import { s2t } from "./lib/s2t.mjs";

// Load secrets env so libs can access RECALL_API_KEY / region / etc.
const SECRETS_ENV = join(homedir(), ".openclaw/secrets/bni-masta.env");
if (existsSync(SECRETS_ENV)) {
  for (const line of readFileSync(SECRETS_ENV, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.RECALL_WEBHOOK_PORT || 18821);
const TOKEN = process.env.RECALL_WEBHOOK_TOKEN || "";
const VAULT = "<vault-path>";

function checkToken(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, "http://x");
  return url.searchParams.get("token") === TOKEN;
}

// Recall's realtime webhook body shape (per docs):
//   { event: "participant_events.<action>",
//     data: {                          ← evt.data
//       data: {                        ← evt.data.data
//         participant: {id,name,is_host,...},
//         timestamp: {absolute, relative},
//         data: { text, to }           ← only present for chat_message
//       },
//       bot: {id},
//     }
//   }
// Helper: dig participant + timestamp + (for chat) text from the correctly nested layer.
function digRecallData(evt) {
  const outer = evt.data || {};
  const inner = outer.data || {};                 // ← Recall's quirky double-data nesting
  const p = inner.participant || outer.participant || {};
  const ts = inner.timestamp?.absolute || outer.timestamp?.absolute ||
             inner.timestamp || outer.timestamp || new Date().toISOString();
  const botId = outer.bot?.id || inner.bot?.id || evt.bot?.id || null;
  // For chat_message specifically, the message body lives at evt.data.data.data.{text,to}
  const chatBody = inner.data || {};
  return { p, ts, botId, chatBody };
}

function normalize(evt) {
  const e = evt.event || "";
  const { p, ts, botId, chatBody } = digRecallData(evt);
  const base = {
    _raw_event: e,
    timestamp: ts,
    bot_id: botId,
    participant_id: p.id != null ? String(p.id) : null,
    display_name: p.name || "",
    is_host: p.is_host ?? null,
  };
  if (e.endsWith(".join"))           return { ...base, type: "participant_join" };
  if (e.endsWith(".leave"))          return { ...base, type: "participant_leave" };
  if (e.endsWith(".update"))         return { ...base, type: "rename" };
  if (e.endsWith(".speech_on"))      return { ...base, type: "speech" };
  if (e.endsWith(".speech_off"))     return { ...base, type: "speech_end" };
  if (e.endsWith(".webcam_on"))      return { ...base, type: "video_on" };
  if (e.endsWith(".webcam_off"))     return { ...base, type: "video_off" };
  if (e.endsWith(".chat_message"))   return { ...base, type: "chat", text: chatBody.text || "", to: chatBody.to || "" };
  return { ...base, type: e };
}

function writeParticipant(evt) {
  const row = normalize(evt);
  const dir = join(VAULT, "raw/meetings", today());
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "participants.jsonl"), JSON.stringify(row) + "\n");
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Detect if a participant is the bot itself. Exact match against
// BNI_BOT_DISPLAY_NAME (the name we pass to Recall on dispatch). Tighter
// than startsWith — a human can still call themselves "BNI Masta fan"
// and get welcomed normally.
function isBot(displayName) {
  if (!displayName) return false;
  const botName = process.env.BNI_BOT_DISPLAY_NAME || "BNI Masta(<YourName>副主席習ＡＩ助理)";
  return displayName === botName;
}

// Fire-and-forget so one slow handler doesn't back up the webhook
function fireAndForget(p, label) {
  Promise.resolve(p).catch(e => console.error(`[handler:${label}] ${e.message}`));
}

function writeTranscript(evt) {
  const d = evt.data || {};
  const payload = d.data || {};
  const participant = payload.participant || d.participant || {};
  const rawText = (payload.words || []).map(w => w.text || "").join(" ").trim() ||
                  payload.text || "";
  const row = {
    timestamp: d.timestamp?.absolute || payload.timestamp?.absolute || new Date().toISOString(),
    bot_id: d.bot?.id || null,
    participant_id: participant.id ? String(participant.id) : null,
    display_name: participant.name || "",
    text: s2t(rawText),                // normalized to 繁體
    text_raw: rawText !== s2t(rawText) ? rawText : undefined, // keep original only if differed
    words: payload.words ? payload.words.map(w => ({ ...w, text: s2t(w.text) })) : undefined,
  };
  const dir = join(VAULT, "raw/meetings", today());
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "transcript.jsonl"), JSON.stringify(row) + "\n");
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
  if (!checkToken(req)) { res.writeHead(401); return res.end("bad token"); }
  let body = "";
  for await (const chunk of req) body += chunk;
  let evt;
  try { evt = JSON.parse(body); }
  catch { res.writeHead(400); return res.end("bad json"); }

  const eventType = evt.event || evt.type || "unknown";
  const botId = evt.data?.bot?.id || evt.bot?.id || "?";
  console.log(`[${new Date().toISOString()}] ${eventType} bot=${botId}`);

  try {
    if (eventType.startsWith("participant_events.")) {
      writeParticipant(evt);

      // Also drive the in-meeting action handlers (intro/greet/chat-reply).
      // Use digRecallData so we read participant + chat body from Recall's
      // double-nested .data.data layer (not the shallow .data).
      const { p, chatBody } = digRecallData(evt);
      const displayName = p.name || "";
      const participantId = p.id != null ? String(p.id) : null;
      const isHost = !!p.is_host;
      const isSelf = isBot(displayName);
      const date = today();

      if (eventType === "participant_events.join") {
        if (isSelf) {
          fireAndForget(handleBotJoin({ botId, date }), "botJoin");
        } else {
          fireAndForget(handleParticipantJoinOrRename({
            botId, date, participantId, displayName, isHost, isBotItself: false,
          }), "joinOrRename");
        }
      } else if (eventType === "participant_events.update") {
        if (!isSelf) {
          fireAndForget(handleParticipantJoinOrRename({
            botId, date, participantId, displayName, isHost, isBotItself: false,
          }), "joinOrRename");
        }
      } else if (eventType === "participant_events.speech_on"
              || eventType === "participant_events.webcam_on") {
        // DISCOVERY: any activity from a participant we haven't greeted yet
        // triggers the greet flow. Catches humans who joined before the bot.
        if (!isSelf) {
          tryDiscoverParticipant({ botId, date, participantId, displayName });
        }
      } else if (eventType === "participant_events.chat_message") {
        // HARD RULE: public chat only. Recall's `to` field says "everyone" for public.
        const to = chatBody.to || "";
        const text = chatBody.text || "";
        const isPrivate = to && to !== "everyone" && to !== "public";
        // One-time visibility log: prove we now see real content
        console.log(`[chat] from=${displayName || "?"} pid=${participantId || "?"} to=${to || "?"} text=${JSON.stringify(text).slice(0,120)}`);
        if (!isPrivate) {
          fireAndForget(handleChatMessage({
            botId, date, participantId, displayName, text,
            isBotItself: isSelf, isPrivate: false,
          }), "chat");
        } else {
          console.log(`[webhook] dropped private chat from ${displayName} to=${to}`);
        }
      }
    } else if (eventType.startsWith("transcript.")) {
      writeTranscript(evt);
    }
    res.writeHead(200); res.end("ok");
  } catch (e) {
    console.error(`handler error: ${e.message}`);
    res.writeHead(500); res.end(e.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`recall-webhook listening on 127.0.0.1:${PORT}`);
});
