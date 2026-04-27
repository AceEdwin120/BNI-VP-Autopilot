#!/usr/bin/env node
// zoom-join — dispatch a Vexa bot to a Zoom meeting
//
// UX: DM "/zoom-join <url_or_id> [pwd] [title]"
//   - url can be a full invite URL, a plain URL, or just a meeting ID
//   - pwd: raw Zoom meeting password (the "A1L0C6" kind). Zoom accepts raw pwds in ?pwd= query.
//
// On dispatch:
//   - Configures recording_config.realtime_endpoints → our public webhook
//   - Configures transcript provider recallai_streaming (bundled, no external API key)
//   - Saves bot manifest to raw/meetings/<date>/<bot_id>.bot.json

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile(SECRETS_ENV);

const VAULT = "<vault-path>";
const REGION = process.env.VEXA_REGION || "ap-northeast-1";
const WEBHOOK_BASE = process.env.VEXA_WEBHOOK_URL; // e.g. https://<your-webhook-host>/vexa-webhook
const WEBHOOK_TOKEN = process.env.VEXA_WEBHOOK_TOKEN || "";
const BOT_AVATAR_URL = process.env.BNI_BOT_AVATAR_URL ||
  "https://<your-webhook-host>/assets/masta-avatar.html";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// URL normalization — handles every URL shape the operator might paste:
//   1. plain meeting ID ("73444799136") + pwd → builds zoom.us/j/ID?pwd=PWD
//   2. full URL already with ?pwd=<hash> → leave untouched
//   3. full URL without ?pwd= + raw pwd arg → append ?pwd=PWD or &pwd=PWD
function normalizeZoom(url, pwd) {
  url = String(url || "").trim();
  pwd = String(pwd || "").trim();
  if (/^\d{9,11}$/.test(url)) {
    if (!pwd) throw new Error("password required when only meeting ID is given");
    return `https://zoom.us/j/${url}?pwd=${encodeURIComponent(pwd)}`;
  }
  if (/[?&]pwd=/.test(url)) return url; // already carries pwd
  if (pwd) {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}pwd=${encodeURIComponent(pwd)}`;
  }
  return url;
}

async function main() {
  const [, , urlArg, pwdArg, titleArg] = process.argv;
  if (!urlArg) { console.error("usage: dispatch.mjs <zoom_url_or_id> [pwd] [title]"); process.exit(2); }
  const apiKey = process.env.VEXA_API_KEY;
  if (!apiKey) { console.error("VEXA_API_KEY not set"); process.exit(2); }
  if (!WEBHOOK_BASE) { console.error("VEXA_WEBHOOK_URL not set"); process.exit(2); }

  const meetingUrl = normalizeZoom(urlArg, pwdArg);
  const title = titleArg || `今日會議 ${today()}`;
  const webhookUrl = WEBHOOK_TOKEN ? `${WEBHOOK_BASE}?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : WEBHOOK_BASE;

  const body = {
    meeting_url: meetingUrl,
    bot_name: process.env.BNI_BOT_DISPLAY_NAME || "BNI Masta(<YourName>副主席習ＡＩ助理)",
    recording_config: {
      // Bundled STT — no external API key needed. Good enough for mixed Mandarin/English BNI meetings.
      transcript: { provider: { recallai_streaming: {} } },
      // Gallery layout so every participant's face is in the mp4
      video_mixed_layout: "gallery_view_v2",
      // (No chat_messages opt-in needed in recording_config — the opt-in is
      //  purely the "participant_events.chat_message" entry in the events list
      //  on realtime_endpoints below. Recall delivers text inside the event
      //  payload at evt.data.data.data.{text,to}.)
      // Real-time webhook — correct shape per Recall docs
      realtime_endpoints: [
        {
          type: "webhook",
          url: webhookUrl,
          events: [
            "participant_events.join",
            "participant_events.leave",
            "participant_events.update",
            "participant_events.speech_on",
            "participant_events.speech_off",
            "participant_events.webcam_on",
            "participant_events.webcam_off",
            "participant_events.chat_message",
            "transcript.data",
          ],
        },
      ],
    },
    metadata: { title, dispatched_by: "bni-masta", dispatched_at: new Date().toISOString() },
    // Replace the default "lightning bolt" avatar. Recall only accepts kind "webpage"
    // or "default" — we host an HTML page that fills the frame with the lion PNG.
    output_media: {
      camera: {
        kind: "webpage",
        config: { url: BOT_AVATAR_URL },
      },
    },
    // Auto-leave rules — so we don't waste Recall minutes on abandoned meetings.
    automatic_leave: {
      // Leave after 5 minutes if the bot is the ONLY participant (nobody else joined yet)
      bot_detection: {
        using_participant_events: { timeout: 300 }, // 5 min
      },
      // Leave after 15 min stuck in waiting room (host never admits)
      waiting_room_timeout: 900,
      // Leave after 30 min of total silence (nobody speaks)
      silence_detection: { timeout: 1800 },
      // Hard cap: 3 hours. BNI 例會 is 90 min + buffer for 封閉會議 etc.
      in_call_not_recording_timeout: 600,   // 10 min of "in call but not recording"
      everyone_left_timeout: 60,             // 1 min after everyone else leaves
      max_uptime_timeout: 10800,             // 3 hours hard ceiling
    },
  };

  const r = await fetch(`https://${REGION}.vexa/api/v1/bot/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Token ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error(`Vexa ${r.status}: ${await r.text()}`); process.exit(1); }
  const j = await r.json();

  const dir = join(VAULT, "raw/meetings", today());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${j.id}.bot.json`), JSON.stringify(j, null, 2));
  console.log(`🤖 dispatched bot ${j.id}`);
  console.log(`   meeting: ${meetingUrl}`);
  console.log(`   webhook: ${webhookUrl}`);
  console.log(`   manifest: ${join(dir, `${j.id}.bot.json`)}`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
