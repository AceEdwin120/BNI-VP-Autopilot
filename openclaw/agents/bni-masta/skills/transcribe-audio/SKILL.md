---
name: transcribe-audio
description: Transcribe an audio or video file to text using Gemini 2.5 Flash via OpenRouter. Writes the transcript to raw/transcripts/ and auto-triggers ingest-claude. Use for voice notes the operator sends, or ad-hoc audio not from Vexa.
metadata:
  openclaw:
    emoji: "🎙️"
    requires:
      bins: [ffmpeg]
      env: [OPENROUTER_API_KEY]
    triggers:
      - "user sends a voice note, mp3, m4a, mp4, or wav"
      - "/transcribe-audio <path>"
---

# transcribe-audio

Given an audio or video file, produce a Traditional Chinese (or mixed) transcript via OpenRouter's Gemini 2.5 Flash model. Gemini accepts audio directly as base64 and transcribes with good Mandarin performance.

## Inputs

- `audio_path` — absolute path to the media file (mp3, m4a, wav, ogg, flac, aac, mp4 — ffmpeg will extract audio if needed)
- `title` (optional) — short descriptor used in the output filename. Default: source filename.

## Behavior

1. If input is video (mp4/mov/webm), use `ffmpeg -i <in> -vn -acodec libmp3lame -ab 64k <out.mp3>` to extract mono 64kbps audio (keeps payload small).
2. Base64-encode the audio file.
3. POST to `https://openrouter.ai/api/v1/chat/completions` with:
   - Model: `google/gemini-2.5-flash`
   - System: "You are a bilingual Mandarin/English transcriber for BNI business meetings. Produce verbatim transcript. Mark speaker turns as `Speaker A:`, `Speaker B:`, etc. when diarization is unclear. Preserve Traditional Chinese characters."
   - User content: multimodal — text prompt + audio part (base64 data URL)
4. Write result to `raw/transcripts/YYYY-MM-DD_<title>.md` with a yaml front-matter block:
   ```yaml
   ---
   type: transcript
   source: <path>
   duration_sec: <from ffprobe>
   transcribed_by: google/gemini-2.5-flash
   transcribed_at: <iso>
   ---
   ```
5. Auto-invoke `ingest-claude --scope raw/transcripts/`.

Phase lines per SOUL:

```
▸ transcribing (~<N>min) via gemini-2.5-flash…
✓ transcript → raw/transcripts/<file>
▸ Claude compiling…
✓ wiki updated
```

## Fallback

If OpenRouter rejects the file size (>20MB base64), fall back to the bundled `openai-whisper-api` skill (chunks + calls OpenAI Whisper API). Requires `OPENAI_API_KEY` in the secrets env.

## Implementation

Script: `./transcribe.mjs`. Run via `node transcribe.mjs <audio_path> [title]`.
