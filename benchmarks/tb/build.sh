#!/usr/bin/env bash
# Builds /tmp/abx: the bundle harbor_agent.py uploads to /opt/abx in each Terminal-Bench container.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${ABX_OUT:-/tmp/abx}
CATALOG=../nhom-30/axiom-cli/src/llm/catalog
PY=$(ls -d ~/.local/share/uv/python/cpython-3.12.*-linux-x86_64-gnu | head -1)

rm -rf "$OUT"; mkdir -p "$OUT/home"
cargo build --release -q -p ms-cli --target x86_64-unknown-linux-musl  # static: TB images ship older glibc
bun build benchmarks/tb/runner.ts --target=bun --define "process.env.MS_REPL_BATCH_PROMPT=\"${MS_REPL_BATCH_PROMPT:-1}\"" --define "process.env.MS_CPY_WORKFLOW=\"${MS_CPY_WORKFLOW:-1}\"" --define "process.env.MS_CPY_REASONING=\"${MS_CPY_REASONING:-0}\"" --define "process.env.MS_CPY_SESSION_CACHE=\"${MS_CPY_SESSION_CACHE:-1}\"" --outfile "$OUT/runner.js" >/dev/null
cp -r "$CATALOG/providers" "$CATALOG/auth" "$OUT/"   # loadCatalog reads these next to the bundle
cp target/x86_64-unknown-linux-musl/release/ms "$(command -v bun)" integrations/axiom/cpy_kernel.py "$OUT/"
cp -r "$PY" "$OUT/python"
# The bundle inlines axiom-cli as it is on disk, uncommitted edits included (team repo: not committed from here).
# Record exactly what went in so any run can be rebuilt: HEAD + diff of tracked and untracked files.
A=../nhom-30
{ git -C $A rev-parse HEAD; git -C $A status --short -- axiom-cli; } > "$OUT/axiom.rev"
{ git -C $A diff HEAD -- axiom-cli; git -C $A ls-files --others --exclude-standard -z -- axiom-cli/src | xargs -0 -r -I{} git -C $A diff --no-index /dev/null {} || true; } > "$OUT/axiom.diff"
rm -rf "$OUT"/python/lib/python3.*/{test,idlelib,tkinter,turtledemo,ensurepip}

# Only access tokens go in (PROVIDERS, default openai-codex): no refresh token, so nothing in a container can rotate the host login.
python3 - "$OUT/home/auth.json" ${PROVIDERS:-openai-codex} <<'EOF'
import json, sys, time
auth = json.load(open('/home/hoang/.axiom/auth.json'))
out = {}
for name in sys.argv[2:]:
    c = auth[name]
    assert c['expires'] / 1000 > time.time() + 3 * 3600, f'{name} access token expires within 3h: refresh it on the host first'
    out[name] = {**c, 'refresh': ''}
json.dump(out, open(sys.argv[1], 'w'))
EOF
chmod 600 "$OUT/home/auth.json"
du -sh "$OUT"
