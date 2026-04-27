// recall-chat — send a public chat message into a Zoom meeting via Vexa.
// Reads env vars INSIDE the function (not at module load) so it picks up values
// loaded after import time (e.g. webhook's secrets-file loader runs post-import).

export async function sendChatMessage(botId, text, { to = "everyone" } = {}) {
  const API_KEY = process.env.VEXA_API_KEY;
  const REGION = process.env.VEXA_REGION || "ap-northeast-1";
  if (!API_KEY) throw new Error("VEXA_API_KEY not set");
  if (!botId) throw new Error("botId required");
  if (!text || !String(text).trim()) return { skipped: "empty" };
  const url = `https://${REGION}.vexa/api/v1/bot/${botId}/send_chat_message/`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Token ${API_KEY}` },
    body: JSON.stringify({ to, message: String(text).trim() }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`send_chat_message ${r.status}: ${txt}`);
  }
  return { ok: true };
}
