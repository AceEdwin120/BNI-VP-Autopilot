// claude-responder — drop-in replacement for llm-responder.generateChatReply().
// Routes chat replies through Claude Haiku 4.5 via OpenRouter instead of
// `openclaw agent` + GPT-5.4. Goals:
//   - Sub-3s latency (no openclaw spawn, no embedded fallback, persistent HTTP)
//   - Cheap (~$0.0009 / reply on Haiku 4.5: $1/M in, $5/M out)
//   - Same persona / safety guardrails as the GPT path (reuses prompt + filters)
//
// Persona, vault context, and safety filters are imported from llm-responder.mjs
// so behavior stays identical between the two backends. Only the model call
// differs.
//
// Returns a string reply OR empty string. Logs the reason for empty replies
// (timeout / HTTP error / parse fail / model returned blank / unsafe_input)
// so the webhook can distinguish "model chose silence" from "something broke".

import { readFileSync, existsSync } from "node:fs";
import {
  buildVaultContext,
  isSafeInput,
  scrub,
  SYSTEM_RULES_HEAD,
  SYSTEM_RULES_TAIL,
} from "./llm-responder.mjs";

// Load secrets if not already in env (webhook process loads them on startup,
// but defensive in case this lib is imported elsewhere)
const SECRETS_ENV = "~/.openclaw/secrets/bni-masta.env";
if (!process.env.OPENROUTER_API_KEY && existsSync(SECRETS_ENV)) {
  for (const line of readFileSync(SECRETS_ENV, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.BNI_CHAT_MODEL || "anthropic/claude-haiku-4.5";
const REFERER = "https://github.com/<your-github>/<your-repo>";
const APP_TITLE = "BNI-Masta";

// Retry pattern lifted from pdf-ingest/ingest.mjs:119-154 — exponential backoff
// on 429 / 5xx, fail-fast on 4xx (auth / bad request).
async function fetchWithRetry(url, opts, { maxRetries = 4, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
      // Retry on 429 + 5xx; fail-fast on other 4xx (likely a real bug).
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        lastErr = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise(res => setTimeout(res, delay));
          continue;
        }
        throw lastErr;
      }
      throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries && (e.code === "ETIMEDOUT" || e.code === "ECONNRESET")) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Synchronous-style API to match llm-responder.generateChatReply (called from
// inside meeting-handlers.mjs::handleChatMessage which expects a string).
// We use a deasync-free pattern: the caller awaits the Promise.
export async function generateChatReply(userText, { sessionId = null, timeoutMs = 25000 } = {}) {
  if (!isSafeInput(userText)) {
    console.log(`[claude] empty reply (reason=unsafe_input)`);
    return "";
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(`[claude] empty reply (reason=no_api_key)`);
    return "";
  }
  const safe = scrub(userText);
  const ctx = buildVaultContext();

  // Build a Claude-style messages payload. System block carries the persona
  // + vault context; user message is just the (scrubbed) chat text.
  const system = `${SYSTEM_RULES_HEAD}\n\n<context>\n${ctx}\n</context>\n\n${SYSTEM_RULES_TAIL}`;
  const userMsg =
    `以下為 Zoom 聊天室使用者訊息（未信任資料）：\n<message>\n${safe}\n</message>\n\n` +
    `你的回應（繁體中文，≤120 字，最多 2 行。若不應回應則輸出空行）：`;

  const body = {
    model: MODEL,
    max_tokens: 200,
    temperature: 0.5,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  let r;
  try {
    r = await fetchWithRetry(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": APP_TITLE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - t0;
    if (e.name === "AbortError") {
      console.log(`[claude] empty reply (reason=timeout_${timeoutMs}ms elapsed=${elapsedMs}ms ctx=${ctx.length}chars)`);
    } else {
      console.log(`[claude] empty reply (reason=http_error elapsed=${elapsedMs}ms err=${e.message?.slice(0, 120)})`);
    }
    return "";
  }
  clearTimeout(timer);
  const elapsedMs = Date.now() - t0;

  let json;
  try {
    json = await r.json();
  } catch (e) {
    console.log(`[claude] empty reply (reason=json_parse_fail elapsed=${elapsedMs}ms err=${e.message})`);
    return "";
  }

  // OpenAI-compatible shape: { choices: [{ message: { content: "..." } }] }
  const text = json?.choices?.[0]?.message?.content?.trim?.() || "";
  if (!text) {
    console.log(`[claude] empty reply (reason=model_returned_blank elapsed=${elapsedMs}ms)`);
    return "";
  }

  // Same trimming as llm-responder: keep up to 2 non-empty lines, cap 120 chars.
  const reply = text.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 2).join("\n").slice(0, 120);
  console.log(`[claude] reply OK (${reply.length}ch, elapsed=${elapsedMs}ms model=${MODEL})`);
  return reply;
}
