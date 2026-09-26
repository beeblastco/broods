# Self-hosted core runtime image (epic #85 phase 9a): one Bun binary serving
# both harness-processing and account-manage over HTTP, routed by Host header.
# Build from the monorepo root: docker build -f apps/core/Dockerfile .
# Pin the digest: the version tag is republished when the base image rebuilds.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/discord-forwarder/package.json ./apps/discord-forwarder/
COPY apps/docs/package.json ./apps/docs/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/matrix-forwarder/package.json ./apps/matrix-forwarder/
COPY packages/ai-sdk-sandbox/package.json ./packages/ai-sdk-sandbox/
COPY packages/convex/package.json ./packages/convex/
COPY packages/broods/package.json ./packages/broods/
# --ignore-scripts skips core's `sst install` postinstall; system prompts are
# generated explicitly in the builder stage instead.
RUN bun install --frozen-lockfile --ignore-scripts

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/core/node_modules ./apps/core/node_modules
COPY --from=deps /app/packages/ai-sdk-sandbox/node_modules ./packages/ai-sdk-sandbox/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
COPY package.json bun.lock ./
# The storage provider require()s @broods/convex/_generated/api (committed).
COPY packages/ai-sdk-sandbox ./packages/ai-sdk-sandbox
COPY packages/convex ./packages/convex
COPY apps/core ./apps/core
# Compile at the amd64 target: the k3s cluster nodes are amd64.
RUN cd apps/core && bun run scripts/compaction-prompt.ts \
    && bun build --compile --target=bun-linux-x64 --minify src/server.ts --outfile /out/core-server

# Reuse the server's PORT parser in the image probe.
RUN bun build apps/core/src/shared/env.ts --target=node --outfile /out/health-env.mjs

FROM node:22-alpine AS isolate-deps
WORKDIR /app/isolate-runner
RUN apk add --no-cache build-base python3 \
    && npm init -y \
    && npm i isolated-vm@7.0.0

FROM alpine:3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ISOLATE_RUNNER_PATH=/app/isolate-runner/runner.mjs
RUN apk add --no-cache ca-certificates libgcc libstdc++ nodejs \
    && addgroup --system --gid 1001 core \
    && adduser --system --uid 1001 core
COPY --from=builder --chown=1001:1001 /out/core-server ./core-server
COPY --from=isolate-deps --chown=1001:1001 /app/isolate-runner/node_modules ./isolate-runner/node_modules
COPY --chown=1001:1001 apps/core/src/harness/isolate/runner/ ./isolate-runner/
COPY --from=builder --chown=1001:1001 /out/health-env.mjs ./health-env.mjs
USER 1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "import { positiveIntegerEnv } from './health-env.mjs'; fetch('http://127.0.0.1:' + positiveIntegerEnv('PORT', 3000) + '/healthz', { signal: AbortSignal.timeout(4000) }).then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1));"]
CMD ["./core-server"]
