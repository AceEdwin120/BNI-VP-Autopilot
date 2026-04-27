#!/usr/bin/env node
// member-upsert — append a member record to raw/inbox/members_YYYY-MM-DD.jsonl
//
// Usage: node upsert.mjs '<json>'

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const VAULT = "<vault-path>";
const INBOX = join(VAULT, "raw/inbox");

function todayFile() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(INBOX, `members_${y}-${m}-${day}.jsonl`);
}

function main() {
  const [, , payloadArg] = process.argv;
  if (!payloadArg) {
    console.error("usage: upsert.mjs '<json>'");
    process.exit(2);
  }
  let obj;
  try {
    obj = JSON.parse(payloadArg);
  } catch (e) {
    console.error(`invalid JSON: ${e.message}`);
    process.exit(2);
  }
  if (!obj.name || typeof obj.name !== "string") {
    console.error("field 'name' is required and must be a non-empty string");
    process.exit(2);
  }
  obj._submitted_at = new Date().toISOString();
  mkdirSync(INBOX, { recursive: true });
  appendFileSync(todayFile(), JSON.stringify(obj) + "\n");
  console.log(`✔ queued ${obj.name} → ${todayFile()}`);
}

main();
