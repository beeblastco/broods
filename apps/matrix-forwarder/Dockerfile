# Build from the monorepo root: docker build -f apps/matrix-forwarder/Dockerfile .
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
RUN bun install --frozen-lockfile --ignore-scripts
# --ignore-scripts skipped the crypto package's postinstall, so fetch its prebuilt
# .node here, on musl, and copy the package out with symlinks resolved.
RUN cd apps/matrix-forwarder/node_modules/@matrix-org/matrix-sdk-crypto-nodejs \
    && bun download-lib.js \
    && mkdir -p /out/node_modules/@matrix-org \
    && cp -RL . /out/node_modules/@matrix-org/matrix-sdk-crypto-nodejs

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY packages/convex ./packages/convex
# Imported by relative path: core's env helpers and Matrix wire contract, and the
# Discord forwarder's config, connection watch, backoff and log helpers. Rename
# either core file and this build breaks.
COPY apps/core/src/shared/env.ts ./apps/core/src/shared/env.ts
COPY apps/core/src/shared/matrix-wire.ts ./apps/core/src/shared/matrix-wire.ts
COPY apps/discord-forwarder/src ./apps/discord-forwarder/src
COPY apps/matrix-forwarder ./apps/matrix-forwarder
# bun installs one copy of a dependency per workspace that declares it, so every
# workspace the bundle reaches needs its own node_modules.
COPY --from=deps /app/apps/discord-forwarder/node_modules ./apps/discord-forwarder/node_modules
COPY --from=deps /app/apps/matrix-forwarder/node_modules ./apps/matrix-forwarder/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
# A JS bundle, not --compile: a compiled binary cannot load the native .node the
# crypto package requires at runtime, so that package stays external.
RUN bun build apps/matrix-forwarder/src/main.ts --target=bun \
    --external @matrix-org/matrix-sdk-crypto-nodejs --minify --outfile /out/main.js

# Reuse the server's PORT parser in the image probe.
RUN bun build apps/core/src/shared/env.ts --target=bun --outfile /out/health-env.mjs

FROM ${BUN_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN addgroup --system --gid 1001 forwarder \
    && adduser --system --uid 1001 --ingroup forwarder forwarder
COPY --from=builder --chown=1001:1001 /out/main.js ./main.js
COPY --from=deps --chown=1001:1001 /out/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /out/health-env.mjs ./health-env.mjs
USER 1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["bun", "--input-type=module", "-e", "import { positiveIntegerEnv } from './health-env.mjs'; fetch('http://127.0.0.1:' + positiveIntegerEnv('PORT', 3000) + '/healthz', { signal: AbortSignal.timeout(4000) }).then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1));"]
CMD ["bun", "main.js"]
