#!/usr/bin/env bash
# Installs a packed broods tarball into a fresh project and uses it the way a
# user would: the CLI starts and reports its version, both entry points import,
# and a consumer typechecks against the shipped types. check-broods-sdk.yaml
# runs it once per supported runtime. skipLibCheck stays on, as in most
# projects: `ai`, a peer, ships types that need @types/node.
#
# Usage: scripts/sdk-tarball-smoke.sh <broods-x.y.z.tgz> <node|bun>
set -euo pipefail

tarball="$(realpath "$1")"
runtime="$2"
repo="$(cd "$(dirname "$0")/.." && pwd)"
typescript="$(jq -r .devDependencies.typescript "$repo/package.json")"
project="$(mktemp -d)"
cd "$project"

echo '{ "name": "broods-smoke", "private": true, "type": "module" }' > package.json
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "module": "nodenext",
    "target": "es2022",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["consumer.ts"]
}
JSON
cat > consumer.ts <<'TS'
import {
  BroodsAccountClient,
  BroodsClient,
  BroodsWebSocketClient,
  defineAgent,
  env,
} from "broods";
import { BroodsAccountClient as AccountClient } from "broods/account";

export const agent = defineAgent({
  name: "smoke",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  agent: { system: "You are a helpful assistant." },
});
// @ts-expect-error A missing name must fail, or the shipped types are `any`.
defineAgent({ agent: { system: "No name." } });
export const clients: unknown[] = [
  BroodsClient,
  BroodsWebSocketClient,
  BroodsAccountClient,
  AccountClient,
];
TS

if [[ "$runtime" == "bun" ]]; then
  bun add "$tarball" "typescript@$typescript"
  run=(bun)
  imports=(bun -e)
else
  npm install --no-audit --no-fund "$tarball" "typescript@$typescript"
  run=(env)
  imports=(node --input-type=module -e)
fi

"${run[@]}" node_modules/.bin/broods --help > /dev/null
expected="$(jq -r .version node_modules/broods/package.json)"
actual="$("${run[@]}" node_modules/.bin/broods --version)"
if [[ "$actual" != "$expected" ]]; then
  echo "broods --version printed '$actual', expected $expected" >&2
  exit 1
fi
"${imports[@]}" "await import('broods'); await import('broods/account');"
node_modules/.bin/tsc -p tsconfig.json
echo "broods $expected works on $runtime"
