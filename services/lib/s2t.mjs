// s2t — Simplified → Traditional Chinese (Taiwan variant) conversion via OpenCC.
// Vexa's STT outputs 簡體 even for Taiwan Mandarin speech; this normalizes
// to 繁體 with Taiwan-specific phrase substitutions (s2twp.json config).
//
// brew install opencc  — must be present. If missing, we fall through unchanged.

import { spawnSync, execFileSync } from "node:child_process";

let _available = null;
function isAvailable() {
  if (_available !== null) return _available;
  try { execFileSync("opencc", ["--version"], { stdio: "ignore" }); _available = true; }
  catch { _available = false; console.warn("[s2t] opencc not installed — passing through"); }
  return _available;
}

// Cheap heuristic: contains any of the common simplified-only characters?
// If not, skip conversion (faster path).
const SIMPLIFIED_HINTS = /[么们们来这这个个会说时会这这这们她他它请过发国说这对还後于后於]/;
function looksSimplified(s) { return typeof s === "string" && SIMPLIFIED_HINTS.test(s); }

export function s2t(text) {
  if (!text || typeof text !== "string") return text;
  if (!looksSimplified(text)) return text;
  if (!isAvailable()) return text;
  const r = spawnSync("opencc", ["-c", "s2twp.json"], {
    input: text, encoding: "utf8", timeout: 5000,
  });
  if (r.status !== 0) return text;
  return (r.stdout || "").replace(/\n$/, "");
}

// Batch converter: walks an object/array and converts any string field that's
// simplified. Used for transcript payloads + jsonl rows.
export function s2tDeep(obj, keys = ["text"]) {
  if (Array.isArray(obj)) return obj.map(x => s2tDeep(x, keys));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k) && typeof v === "string") out[k] = s2t(v);
      else out[k] = s2tDeep(v, keys);
    }
    return out;
  }
  return obj;
}
