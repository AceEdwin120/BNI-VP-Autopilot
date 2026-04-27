#!/usr/bin/env node
// transcribe-audio — transcribe an audio/video file via OpenRouter Gemini 2.5 Flash

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const VAULT = "<vault-path>";
const OUT_DIR = join(VAULT, "raw/transcripts");
const MODEL = "google/gemini-2.5-flash";
const MAX_BASE64_BYTES = 20 * 1024 * 1024; // 20MB OpenRouter ceiling (approx)

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac"]);

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { encoding: "utf8" },
    );
    return Math.round(parseFloat(out.trim()));
  } catch {
    return null;
  }
}

function extractAudio(videoPath) {
  const outPath = videoPath.replace(extname(videoPath), ".extracted.mp3");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-ab", "64k", "-ac", "1", outPath],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) throw new Error("ffmpeg extraction failed");
  return outPath;
}

function mimeFor(ext) {
  return {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
  }[ext] || "audio/mpeg";
}

async function callOpenRouter(audioPath) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const bytes = readFileSync(audioPath);
  const b64 = bytes.toString("base64");
  if (b64.length > MAX_BASE64_BYTES) {
    throw new Error(`audio too large for single OpenRouter call: ${b64.length} bytes base64`);
  }
  const body = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a bilingual Mandarin/English transcriber for BNI business meetings. Produce a verbatim transcript. Mark speaker turns as `Speaker A:`, `Speaker B:`, etc. when diarization is unclear. Preserve Traditional Chinese characters. Output Markdown.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this audio. Keep timestamps every ~30s if possible." },
          { type: "input_audio", input_audio: { data: b64, format: extname(audioPath).slice(1) || "mp3" } },
        ],
      },
    ],
  };
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/<your-github>/<your-repo>",
      "X-Title": "BNI-Masta",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenRouter ${r.status}: ${t.slice(0, 500)}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const [, , pathArg, titleArg] = process.argv;
  if (!pathArg) {
    console.error("usage: transcribe.mjs <audio_path> [title]");
    process.exit(2);
  }
  const src = resolve(pathArg);
  if (!existsSync(src)) {
    console.error(`not found: ${src}`);
    process.exit(2);
  }
  const ext = extname(src).toLowerCase();
  let audio = src;
  if (VIDEO_EXT.has(ext)) {
    console.log("→ extracting audio from video");
    audio = extractAudio(src);
  } else if (!AUDIO_EXT.has(ext)) {
    console.error(`unsupported extension: ${ext}`);
    process.exit(2);
  }
  const duration = ffprobeDuration(audio);
  const title = (titleArg || basename(src, extname(src))).replace(/[^\w\u4e00-\u9fff.-]+/g, "_");
  console.log(`→ transcribing ${audio} (${duration ?? "?"}s) via ${MODEL}`);
  const transcript = await callOpenRouter(audio);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${today()}_${title}.md`);
  const fm = [
    "---",
    "type: transcript",
    `source: ${src}`,
    `duration_sec: ${duration ?? "null"}`,
    `transcribed_by: ${MODEL}`,
    `transcribed_at: ${new Date().toISOString()}`,
    "---",
    "",
    transcript,
    "",
  ].join("\n");
  writeFileSync(outPath, fm);
  console.log(`✔ wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
