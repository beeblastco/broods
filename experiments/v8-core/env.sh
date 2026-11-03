# Sourced by start-*.sh: the env local-stack gives core, read from the stack's
# own state.json, plus the bench switches. Secrets never touch a file here.
# The stack is the one of STACK_ROOT (default: this checkout), as local-stack.ts names it, or
# BROODS_LOCAL_INSTANCE; with neither there, the most recently used stack.
v8_core=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
eval "$(python3 - "${STACK_ROOT:-$v8_core/../..}" "${BROODS_LOCAL_INSTANCE:-}" <<'PY'
import glob, hashlib, json, os, shlex, sys
root, instance = os.path.abspath(sys.argv[1]), sys.argv[2]
home = os.path.expanduser("~/.broods-local")
if not instance:
    own = f"{os.path.basename(root)}-{hashlib.sha1(root.encode()).hexdigest()[:8]}"
    states = sorted(glob.glob(f"{home}/*/state.json"), key=os.path.getmtime)
    instance = own if os.path.exists(f"{home}/{own}/state.json") or not states else os.path.basename(os.path.dirname(states[-1]))
d = json.load(open(f"{home}/{instance}/state.json")); s = d["secrets"]; base = d.get("portBase")
env = {
  "ACCOUNT_CONFIG_ENCRYPTION_SECRET": s["accountConfigEncryption"],
  "ADMIN_ACCOUNT_SECRET": s["adminAccount"],
  "CONVEX_DEPLOY_KEY": d.get("adminKey") or "",
  "MEDIA_TICKET_SECRET": s["mediaTicket"],
  "SERVICE_AUTH_SECRET": s["serviceAuth"],
  "STAGE_TICKET_SECRET": s["stageTicket"],
  "TERMINAL_TICKET_SECRET": s["terminalTicket"],
  "CONVEX_URL": f"http://127.0.0.1:{base + 2}",
  "PUBLIC_BASE_URL": f"http://127.0.0.1:{base}",
}
for k, v in env.items(): print(f"export {k}={shlex.quote(v)}")
# The bench's cores take the stack core's place: Bun on base+1, workerd on base+11, isolates on base+21.
print(f"export STACK_PORT_BASE={base} BENCH_PORT_BASE=${{BENCH_PORT_BASE:-{base}}}")
PY
)"
export ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
export CLOUDFLARE_WORKER_URL=${CLOUDFLARE_WORKER_URL:-}
export CLOUDFLARE_WORKER_API_KEY=${CLOUDFLARE_WORKER_API_KEY:-}
# Core's `cloudflare` sandbox provider (bench --sandbox-provider cloudflare): the bridge Worker.
export CLOUDFLARE_SANDBOX_URL=${CLOUDFLARE_SANDBOX_URL:-}
export CLOUDFLARE_SANDBOX_API_KEY=${CLOUDFLARE_SANDBOX_API_KEY:-}
export BENCH_SCRIPTED_MODEL=${BENCH_SCRIPTED_MODEL:-0}
export BENCH_MODEL_DELAY_MS=${BENCH_MODEL_DELAY_MS:-0}
# Core's in-process run limit; 8 is core's own default.
export MAX_INPROCESS_WORKERS=${MAX_INPROCESS_WORKERS:-8}
unset BUN_OPTIONS HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
# workerd for this machine, newest installed version.
workerd_bin() {
  local platform
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux-64 ;;
    Linux-aarch64) platform=linux-arm64 ;;
    Darwin-arm64) platform=darwin-arm64 ;;
    Darwin-x86_64) platform=darwin-64 ;;
    *) echo "no workerd for $(uname -sm)" >&2; return 1 ;;
  esac
  find "$v8_core/../../node_modules/.bun" -path "*workerd-$platform@*" -name workerd -type f | sort | tail -1
}
