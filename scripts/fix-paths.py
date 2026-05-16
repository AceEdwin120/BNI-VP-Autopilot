#!/usr/bin/env python3
"""
fix-paths.py — 安裝時注入 vault 路徑，並複製修正後的 agent 檔案到 ~/.openclaw/

用法（在 WSL2 內執行）：
  python3 scripts/fix-paths.py \\
    --vault "/mnt/c/Users/User/Documents/BNI AGENT/BNI AGENT" \\
    --agent-dir "$HOME/.openclaw/agents/bni-masta"

功能：
  1. 把 <vault-path> 替換成真實 vault 路徑（所有 .mjs 和 .sh 檔案）
  2. 把替換後的檔案複製到 --agent-dir
  3. 建立必要的目錄結構
"""

import argparse
import os
import shutil
import stat
from pathlib import Path

PLACEHOLDER = "<vault-path>"

# 需要注入 vault 路徑的來源檔案（相對於 repo 根目錄）
TARGET_FILES = [
    "openclaw/agents/bni-masta/skills/meeting-poll/poll.mjs",
    "openclaw/agents/bni-masta/skills/resolve-attendance/resolve.mjs",
    "openclaw/agents/bni-masta/skills/pdf-ingest/ingest.mjs",
    "openclaw/agents/bni-masta/skills/ingest-claude/compile.sh",
    "openclaw/agents/bni-masta/skills/transcribe-audio/transcribe.mjs",
    "openclaw/agents/bni-masta/skills/zoom-join/dispatch.mjs",
    "openclaw/agents/bni-masta/skills/member-upsert/upsert.mjs",
    "openclaw/agents/bni-masta/skills/attendance-to-sheet/update.mjs",
    "openclaw/agents/bni-masta/skills/roster-sync/sync.mjs",
    "openclaw/agents/bni-masta/skills/post-meeting-digest/digest.mjs",
    "openclaw/agents/bni-masta/skills/personal-line-broadcast/broadcast.mjs",
    "openclaw/agents/bni-masta/skills/detailed-meeting-report/detailed.mjs",
    "openclaw/agents/bni-masta/skills/meeting-deck-report/deck.mjs",
    "openclaw/agents/bni-masta/skills/meeting-report/report.sh",
    "services/recall-webhook.mjs",
    "services/lib/meeting-handlers.mjs",
    "services/lib/llm-responder.mjs",
    "services/lib/claude-responder.mjs",
    "services/lib/qa-cache.mjs",
    "services/lib/roster-match.mjs",
]


def make_executable(path: Path):
    current = path.stat().st_mode
    path.chmod(current | stat.S_IXUSR | stat.S_IXGRP)


def inject_vault(content: str, vault_path: str) -> str:
    return content.replace(PLACEHOLDER, vault_path)


def copy_with_injection(src: Path, dst: Path, vault_path: str):
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        content = src.read_text(encoding="utf-8")
        if PLACEHOLDER in content:
            content = inject_vault(content, vault_path)
            print(f"  ✓ injected vault path → {dst}")
        else:
            print(f"  · copied (no placeholder) → {dst}")
        dst.write_text(content, encoding="utf-8")
    except UnicodeDecodeError:
        # Binary file — copy as-is
        shutil.copy2(src, dst)
        print(f"  · copied binary → {dst}")

    # Preserve executable bits from source
    if os.access(src, os.X_OK):
        make_executable(dst)


def main():
    parser = argparse.ArgumentParser(description="Inject vault path and copy agent files.")
    parser.add_argument("--vault", required=True,
                        help="Absolute vault path (WSL2 view), e.g. /mnt/c/Users/User/Documents/BNI AGENT/BNI AGENT")
    parser.add_argument("--agent-dir", required=True,
                        help="Destination agent dir, e.g. $HOME/.openclaw/agents/bni-masta")
    parser.add_argument("--repo", default=None,
                        help="Repo root (defaults to parent of this script)")
    args = parser.parse_args()

    vault_path = args.vault.rstrip("/")
    agent_dir = Path(args.agent_dir).expanduser().resolve()
    repo_root = Path(args.repo).resolve() if args.repo else Path(__file__).parent.parent.resolve()

    print(f"Repo root : {repo_root}")
    print(f"Agent dir : {agent_dir}")
    print(f"Vault path: {vault_path}")
    print()

    # 1. 複製並注入指定的 skill/service 檔案
    print("── Injecting vault path into skill files ──")
    for rel in TARGET_FILES:
        src = repo_root / rel
        if not src.exists():
            print(f"  ⚠ not found, skipping: {src}")
            continue

        # 決定目的地路徑
        if rel.startswith("openclaw/agents/bni-masta/skills/"):
            skill_rel = Path(rel).relative_to("openclaw/agents/bni-masta/skills")
            dst = agent_dir / "agent/skills" / skill_rel
        elif rel.startswith("openclaw/agents/bni-masta/"):
            inner = Path(rel).relative_to("openclaw/agents/bni-masta")
            dst = agent_dir / inner
        elif rel.startswith("services/lib/"):
            lib_rel = Path(rel).relative_to("services/lib")
            dst = agent_dir / "services/lib" / lib_rel
        elif rel.startswith("services/"):
            svc_rel = Path(rel).relative_to("services")
            dst = agent_dir / "services" / svc_rel
        else:
            print(f"  ⚠ unknown prefix, skipping: {rel}")
            continue

        copy_with_injection(src, dst, vault_path)

    # 2. 複製 SOUL.md
    print()
    print("── Copying SOUL.md ──")
    soul_src = repo_root / "openclaw/agents/bni-masta/SOUL.md"
    soul_dst = agent_dir / "agent/SOUL.md"
    if soul_src.exists():
        soul_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(soul_src, soul_dst)
        print(f"  ✓ {soul_dst}")
    else:
        print(f"  ⚠ SOUL.md not found at {soul_src}")

    # 3. 複製 services/package.json
    print()
    print("── Copying services/package.json ──")
    pkg_src = repo_root / "services/package.json"
    pkg_dst = agent_dir / "services/package.json"
    if pkg_src.exists():
        pkg_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pkg_src, pkg_dst)
        print(f"  ✓ {pkg_dst}")

    # 4. 建立 vault 目錄結構（如果不存在）
    print()
    print("── Ensuring vault directory structure ──")
    vault = Path(vault_path)
    dirs = [
        "raw/handbooks", "raw/transcripts", "raw/roll_calls",
        "raw/meetings", "raw/visitors", "raw/inbox",
        "wiki/rules", "wiki/members", "wiki/meetings",
        "wiki/chapters", "wiki/events", "wiki/reports",
        "_templates", "_dashboards",
    ]
    for d in dirs:
        (vault / d).mkdir(parents=True, exist_ok=True)
    print(f"  ✓ vault structure ready at {vault}")

    # 5. 複製 vault 範本檔案（不覆蓋既有檔案）
    print()
    print("── Seeding vault template files ──")
    vault_src = repo_root / "vault"
    if vault_src.exists():
        for src_file in vault_src.rglob("*"):
            if src_file.is_dir():
                continue
            rel = src_file.relative_to(vault_src)
            dst_file = vault / rel
            if dst_file.exists():
                print(f"  · skip (exists): {rel}")
            else:
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)
                print(f"  ✓ seeded: {rel}")
    else:
        print(f"  ⚠ vault/ not found in repo at {vault_src}")

    print()
    print("✔ fix-paths complete.")
    print(f"  Next: fill in ~/.openclaw/secrets/bni-masta.env then run openclaw onboard")


if __name__ == "__main__":
    main()
