# Sourced by start-*.sh: the env local-stack gives core, read from the stack's
# own state.json, plus the bench switches. Secrets never touch a file here.
state=~/.broods-local/${BROODS_LOCAL_INSTANCE:-broods-84a0a314}/state.json
eval "$(python3 - "$state" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1])); s = d["secrets"]; base = d.get("portBase")
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
PY
)"
export ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
export CLOUDFLARE_WORKER_URL=${CLOUDFLARE_WORKER_URL:-}
export CLOUDFLARE_WORKER_API_KEY=${CLOUDFLARE_WORKER_API_KEY:-}
export BENCH_SCRIPTED_MODEL=${BENCH_SCRIPTED_MODEL:-0}
export BENCH_MODEL_DELAY_MS=${BENCH_MODEL_DELAY_MS:-0}
# Core's in-process run limit; 8 is core's own default.
export MAX_INPROCESS_WORKERS=${MAX_INPROCESS_WORKERS:-8}
unset BUN_OPTIONS HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
