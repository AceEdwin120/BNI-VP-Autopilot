---
name: member-upsert
description: Append a structured member record to raw/inbox/ for Claude to ingest into wiki/members/. Use when the operator gives the bot new info about a member (expertise, phone, alias, status change, etc.).
metadata:
  openclaw:
    emoji: "👤"
    triggers:
      - "/member-upsert"
      - "/member <name> ..."
      - "when the operator volunteers new info about a named BNI member"
---

# member-upsert

Quick-write a new or updated member record into `raw/inbox/members_<date>.jsonl`. The next `ingest-claude` pass will fold it into `wiki/members/<name>.md` (creating or updating the page per the front-matter contract in `CLAUDE.md`).

## Inputs (JSON object; any field may be omitted)

```json
{
  "name": "張大明",              // required
  "chapter": "台北中山分會",
  "expertise": "商業保險",
  "joined": "2023-06-15",
  "status": "active",             // active | pending | resigned | suspended
  "aliases": ["Dave Chang", "大明"],
  "telegram_id": null,
  "phone": "0912-345-678",
  "email": "dave@example.com",
  "note": "free-form notes from this conversation"
}
```

## Behavior

1. Append one JSON line to `raw/inbox/members_YYYY-MM-DD.jsonl` with an added `_submitted_at` ISO timestamp.
2. Emit phase line per SOUL: `✓ queued <name> → raw/inbox/members_<date>.jsonl`
3. If the operator asks, auto-invoke `ingest-claude --scope raw/inbox/`.

## Implementation

Script: `./upsert.mjs`. Run via `node upsert.mjs '<json>'`.

## Rationale

Append-only to `raw/` respects the LLM-Wiki boundary: the bot never writes to `wiki/`. Claude is the only thing that touches wiki pages, preserving the "single writer" invariant.
