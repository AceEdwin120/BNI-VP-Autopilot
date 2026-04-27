#!/usr/bin/env node
// assets-server — serves ~/.openclaw/agents/bni-masta/assets/ on :18822
// Exposed publicly via cloudflared at https://<your-webhook-host>/assets/*

import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, resolve, join } from "node:path";

const PORT = 18822;
const ROOT = "~/.openclaw/agents/bni-masta/assets";
const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };

createServer((req, res) => {
  // Strip /assets prefix if cloudflared forwards it with the prefix
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname.startsWith("/assets/")) pathname = pathname.slice(7);
  if (pathname === "/assets") pathname = "/";
  const filePath = resolve(join(ROOT, pathname));
  // Prevent path traversal
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) { res.writeHead(404); return res.end("not found"); }
  const mime = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": mime,
    "cache-control": "public, max-age=3600",
  });
  createReadStream(filePath).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`assets-server on 127.0.0.1:${PORT} root=${ROOT}`));
