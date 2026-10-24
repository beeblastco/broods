# Core's Bun server and its native Node isolate runner.
# Build from the monorepo root: docker build -f apps/core/Dockerfile .
# Pin the digest: the version tag is republished when the base image rebuilds.
# checkov:skip=CKV_DOCKER_7:Image args pin a version and digest; the scanner does not resolve ARG in FROM.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
ARG NODE_IMAGE=node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/discord-forwarder/package.json ./apps/discord-forwarder/
COPY apps/docs/package.json ./apps/docs/
COPY apps/edge/package.json ./apps/edge/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/matrix-forwarder/package.json ./apps/matrix-forwarder/
COPY packages/ai-sdk-sandbox/package.json ./packages/ai-sdk-sandbox/
COPY packages/convex/package.json ./packages/convex/
COPY packages/broods/package.json ./packages/broods/
# --ignore-scripts skips core's `sst install` postinstall; system prompts are
# generated explicitly in the builder stage instead.
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
# The storage provider require()s @broods/convex/_generated/api (committed).
COPY packages/ai-sdk-sandbox ./packages/ai-sdk-sandbox
COPY packages/convex ./packages/convex
COPY apps/core ./apps/core
# The cloudflare executor clamps its requests with the bridge's own limits, and
# the accounts handler signs terminal tokens in the bridge's own format. The
# worker executor clamps with its Worker's limits the same way.
COPY apps/cloudflare-sandbox/src/limits.ts apps/cloudflare-sandbox/src/terminal-token.ts ./apps/cloudflare-sandbox/src/
COPY apps/cloudflare-worker/src/limits.ts ./apps/cloudflare-worker/src/
# Compile at the amd64 target: the k3s cluster nodes are amd64.
RUN cd apps/core && bun run scripts/compaction-prompt.ts \
    && bun build --compile --target=bun-linux-x64 --minify src/server.ts --outfile /out/core-server

# Pi resizes every prompt image with Photon, whose WASM a compiled binary reads
# from beside itself. Without it, pi drops each image the user sends.
RUN cd apps/core && bun -e 'const pi = Bun.resolveSync("@ai-sdk/harness-pi", process.cwd()); const agent = Bun.resolveSync("@earendil-works/pi-coding-agent", pi); await Bun.write("/out/photon_rs_bg.wasm", Bun.file(Bun.resolveSync("@silvia-odwyer/photon-node/photon_rs_bg.wasm", agent)));'

# Reuse the server's PORT parser in the image probe.
RUN bun build apps/core/src/shared/env.ts --target=node --outfile /out/health-env.mjs

FROM ${NODE_IMAGE} AS isolate-deps
WORKDIR /app/isolate-runner
# The pinned package ships prebuilds. Keep only the addon for this Node ABI,
# architecture and libc instead of carrying every platform into the runtime.
# Load the trimmed copy here so missing runtime files fail the image build.
RUN npm init -y \
    && npm i --ignore-scripts isolated-vm@7.0.0 \
    && mkdir -p /out/node_modules/isolated-vm/build/Release \
    && cp -R node_modules/node-gyp-build /out/node_modules/ \
    && cp node_modules/isolated-vm/package.json node_modules/isolated-vm/isolated-vm.js node_modules/isolated-vm/LICENSE /out/node_modules/isolated-vm/ \
    && node -e "require('node:fs').copyFileSync(require('node-gyp-build').path(require('node:path').resolve('node_modules/isolated-vm')), '/out/node_modules/isolated-vm/build/Release/isolated_vm.node')" \
    && cd /out && node -e "new (require('isolated-vm').Isolate)().dispose()"

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ISOLATE_RUNNER_PATH=/app/isolate-runner/runner.mjs
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
    && addgroup --system --gid 1001 core \
    && adduser --system --uid 1001 core
COPY --from=builder --chown=1001:1001 /out/core-server /out/photon_rs_bg.wasm ./
COPY --from=isolate-deps --chown=1001:1001 /out/node_modules ./isolate-runner/node_modules
COPY --chown=1001:1001 apps/core/src/harness/isolate/runner/ ./isolate-runner/
COPY --from=builder --chown=1001:1001 /out/health-env.mjs ./health-env.mjs
USER 1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "import { positiveIntegerEnv } from './health-env.mjs'; fetch('http://127.0.0.1:' + positiveIntegerEnv('PORT', 3000) + '/healthz', { signal: AbortSignal.timeout(4000) }).then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1));"]
CMD ["./core-server"]
