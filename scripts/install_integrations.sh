#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_PI=false
INSTALL_CLAUDE=false
DRY_RUN=false
ALLOW_WRITE=true
MS_BIN=""
WS_ROOT="."
STATE_DIR="${HOME}/.local/state/ms"

usage() {
    cat <<'EOF'
Usage: install_integrations.sh [OPTIONS]

Wire `ms mcp` into Pi (~/.pi/agent/mcp.json) and/or Claude Code (~/.claude.json).
Existing JSON keys and other MCP servers are preserved; existing files are backed up before modification.

Targets:
  --pi                Install into $HOME/.pi/agent/mcp.json
  --claude            Install into $HOME/.claude.json
  --all               Install into both Pi and Claude Code (default if no target given)

Options:
  --dry-run           Show planned changes without modifying any files
  --ms-bin <PATH>     Path to `ms` binary (auto-detected if omitted)
  --root <DIR>        Workspace root passed to `ms mcp --root` (default: .)
  --state-dir <DIR>   State dir passed to `ms mcp --state-dir` (default: $HOME/.local/state/ms)
  --read-only         Configure `ms mcp` without --allow-write
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pi)
            INSTALL_PI=true
            shift
            ;;
        --claude)
            INSTALL_CLAUDE=true
            shift
            ;;
        --all)
            INSTALL_PI=true
            INSTALL_CLAUDE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --ms-bin)
            MS_BIN="${2:?--ms-bin requires a path}"
            shift 2
            ;;
        --root)
            WS_ROOT="${2:?--root requires a path}"
            shift 2
            ;;
        --state-dir)
            STATE_DIR="${2:?--state-dir requires a path}"
            shift 2
            ;;
        --read-only)
            ALLOW_WRITE=false
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ "${INSTALL_PI}" == "false" && "${INSTALL_CLAUDE}" == "false" ]]; then
    INSTALL_PI=true
    INSTALL_CLAUDE=true
fi

if [[ -z "${MS_BIN}" ]]; then
    if command -v ms >/dev/null 2>&1; then
        MS_BIN="$(command -v ms)"
    elif [[ -x "${REPO_ROOT}/target/release/ms" ]]; then
        MS_BIN="${REPO_ROOT}/target/release/ms"
    elif [[ -x "${REPO_ROOT}/target/debug/ms" ]]; then
        MS_BIN="${REPO_ROOT}/target/debug/ms"
    else
        MS_BIN="${REPO_ROOT}/target/release/ms"
        echo "Warning: ms binary not found on PATH or in target/; using ${MS_BIN}" >&2
    fi
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is required to safely merge JSON config files." >&2
    exit 1
fi

update_mcp_json() {
    local target_file="$1"
    local label="$2"

    python3 - "${target_file}" "${label}" "${MS_BIN}" "${WS_ROOT}" "${STATE_DIR}" "${ALLOW_WRITE}" "${DRY_RUN}" <<'PY'
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

target_path = Path(sys.argv[1])
label = sys.argv[2]
ms_bin = sys.argv[3]
ws_root = sys.argv[4]
state_dir = sys.argv[5]
allow_write = sys.argv[6] == "true"
dry_run = sys.argv[7] == "true"

args = ["mcp", "--root", ws_root]
if allow_write:
    args.extend(["--allow-write", "--state-dir", state_dir])

desired_entry = {
    "command": ms_bin,
    "args": args,
}

if target_path.exists():
    raw = target_path.read_text(encoding="utf-8")
    if raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"[{label}] Error: existing {target_path} is not valid JSON: {exc}", file=sys.stderr)
            sys.exit(1)
        if not isinstance(data, dict):
            print(f"[{label}] Error: existing {target_path} root must be a JSON object", file=sys.stderr)
            sys.exit(1)
    else:
        data = {}
else:
    data = {}

mcp_servers = data.get("mcpServers")
if mcp_servers is None:
    mcp_servers = {}
elif not isinstance(mcp_servers, dict):
    print(f"[{label}] Error: 'mcpServers' in {target_path} is not a JSON object", file=sys.stderr)
    sys.exit(1)

if mcp_servers.get("ms") == desired_entry:
    print(f"[{label}] {target_path}: already up to date")
    sys.exit(0)

mcp_servers["ms"] = desired_entry
data["mcpServers"] = mcp_servers
new_content = json.dumps(data, indent=2) + "\n"

if dry_run:
    action = "update" if target_path.exists() else "create"
    print(f"[{label}] DRY RUN: would {action} {target_path} with mcpServers.ms = {json.dumps(desired_entry)}")
    sys.exit(0)

target_path.parent.mkdir(parents=True, exist_ok=True)

if target_path.exists():
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup_path = target_path.with_name(f"{target_path.name}.bak.{ts}")
    shutil.copy2(target_path, backup_path)
    print(f"[{label}] Backed up existing config to {backup_path}")

# Atomic write via temp file in the same directory, preserving permissions if file existed
orig_mode = target_path.stat().st_mode & 0o777 if target_path.exists() else 0o600
fd, tmp_name = tempfile.mkstemp(dir=str(target_path.parent), prefix=f".{target_path.name}.tmp.")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(new_content)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp_name, orig_mode)
    os.replace(tmp_name, target_path)
except Exception:
    if os.path.exists(tmp_name):
        os.unlink(tmp_name)
    raise

print(f"[{label}] Updated {target_path} (mcpServers.ms configured)")
PY
}

if [[ "${INSTALL_PI}" == "true" ]]; then
    update_mcp_json "${HOME}/.pi/agent/mcp.json" "pi"
fi

if [[ "${INSTALL_CLAUDE}" == "true" ]]; then
    update_mcp_json "${HOME}/.claude.json" "claude"
fi
