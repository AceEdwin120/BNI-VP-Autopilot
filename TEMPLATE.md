# Using this template

This repo is a **public template** of the system described in
[README.md](README.md). The original (BNI-Masta) was built and runs in
production for one specific chapter, by 馬驊（Alex Ma）— [蟬說](https://www.chanshuo.tw/) /
[痛點科技](https://painpoint-ai.com/) — at his BNI 副主席 role in Taiwan.
This template is a sanitized snapshot you can fork and adapt to your own
chapter.

> **這是一個 template repo。** 原版 BNI-Masta 是 馬驊 為自己分會打造、長期使用中的個人系統；
> 這個 repo 是把所有跟「<YourChapter> / 馬驊個人」綁定的東西抽掉的版本，給其他想做同樣事情的
> 副主席當起點。

---

## What you get

- **Three pipelines** (Post-meeting, LinePc Computer-Use fan-out, AI News Broadcaster) — full code
- **Two-brain architecture** (chat brain + Claude wiki compiler) — runtime topology
- **5-tier fuzzy attendance match** (`resolve-attendance`)
- **31 framework files** sha256-pinned + extension contract
- **Vault structure** (Obsidian + Karpathy LLM-Wiki pattern) — empty, no member PII
- **LaunchAgent plists** + Cloudflare Tunnel config + scheduled-task definitions
- **Runbooks + architecture docs** (RUNBOOK.md, ARCHITECTURE.md, CLAUDE.md, framework-documentation-prompt.md)

## What you must replace before running

This is the meaningful work — the placeholders below MUST be filled in for your
own chapter. Search across the repo for each pattern:

| Placeholder | Meaning | Where it appears |
|---|---|---|
| `<YourChapter>` | Your BNI chapter name (e.g. `BNI 大華分會`) | README, AGENTS, vault, deck/report skills |
| `<YourName>` | Your real name | bot display name, AGENTS.md, SOUL.md |
| `<YourTestGroup>` | LINE test group display name (3-person sandbox) | ai-news + post-meeting configs |
| `<YourCommunityGroup>` | LINE 社群 display name (open community) | ai-news config |
| `<YourChapterMainGroup>` | Your chapter's main LINE group display name | ai-news + post-meeting configs |
| `<your-line-bot-id>` | LINE bot username (e.g. `@xxxxxxx`) | docs |
| `<your-telegram-alert-bot>` | Telegram alert bot username | docs, code comments |
| `<your-line-group-id>` | LINE bot-leg group ID (uppercase `C` prefix) | env, docs |
| `<your-google-sheet-id>` | Roster Sheet ID | env, skills |
| `<your-webhook-host>` | Public hostname for Cloudflare Tunnel (e.g. `bni.example.com`) | env, plists, scripts |
| `<your-google-account>` | Google account that owns the BNI calendar + Sheet | runbook, skills |
| `<your-github-org>` / `<your-github-repo>` | Where you push your fork | docs |

Quick way to find them all:

```bash
grep -rn "<Your\|<your-" .
```

## Vexa (open-source meeting bot)

The original BNI-Masta used Recall.ai. This template was rewritten to **Vexa**
([vexa.ai](https://vexa.ai), MIT-licensed open-source meeting bot) at the
template/config level — env var names, filenames, comments, runbook all point
at Vexa.

**The actual API call code in `skills/zoom-join/dispatch.mjs` and
`services/vexa-webhook.mjs` is still shaped for Recall.ai.** Adapting to Vexa
is your homework — search for `TODO(vexa)` to find the spots that need
rewriting (request bodies, webhook event names, transcript fetching). Vexa's
API is documented at https://github.com/Vexa-ai/vexa.

If you'd rather keep using Recall.ai (~$0.40/hr/bot), the original API shape
already works — you just need to undo the env var rename: search-replace
`VEXA_` → `RECALL_` in your `~/.openclaw/secrets/bni-masta.env`.

## Setup checklist

See [RUNBOOK.md](RUNBOOK.md) for full host provisioning. Short version:

1. Clone this repo
2. Replace placeholders (table above)
3. Copy `.env.example` to `~/.openclaw/secrets/bni-masta.env`, chmod 600, fill in real keys
4. Install OpenClaw + login the chat brain: `openclaw auth add openai-codex`
5. Login Claude CLI: `claude /login`
6. Provision Vexa + Cloudflare Tunnel + LINE Messaging API + Telegram bot
7. Boot LaunchAgents: `bash scripts/install-launchagents.sh`
8. Smoke-test each pipeline (RUNBOOK.md has the commands)

## License

[**Apache License 2.0**](LICENSE) — fork freely. Attribution required: keep the [NOTICE](NOTICE) file and the copyright/attribution headers in derivative works (per Apache 2.0 §4(c)(d)). Includes patent grant (§3) and trademark clause (§6 — does not grant rights to use the "BNI-Masta" name or the original creator's brands).

Attribution back to 馬驊 / [蟬說](https://www.chanshuo.tw/) / [痛點科技](https://painpoint-ai.com/) is built into [NOTICE](NOTICE) and required by §4(d) when redistributing a fork.
