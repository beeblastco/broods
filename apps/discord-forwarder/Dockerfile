# Build from the monorepo root: docker build -f apps/discord-forwarder/Dockerfile .
# Bun 1.4 Rust canary; pin the digest because the canary tag is mutable.
ARG BUN_IMAGE=oven/bun:canary-alpine@sha256:7de23ab3fb549a3945a2c85ae2d9b999e23f2fc72182b705777d2c254795d79f
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/discord-forwarder/package.json ./apps/discord-forwarder/
COPY apps/docs/package.json ./apps/docs/
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/ai-sdk-sandbox/package.json ./packages/ai-sdk-sandbox/
COPY packages/convex/package.json ./packages/convex/
COPY packages/broods/package.json ./packages/broods/
RUN bun install --frozen-lockfile --ignore-scripts

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/discord-forwarder/node_modules ./apps/discord-forwarder/node_modules
COPY package.json bun.lock ./
COPY packages/convex ./packages/convex
# The two core modules the forwarder imports by relative path: the env helpers
# and the deploy-key Convex client. Rename either and this build breaks.
COPY apps/core/src/shared/env.ts ./apps/core/src/shared/env.ts
COPY apps/core/src/shared/convex/client.ts ./apps/core/src/shared/convex/client.ts
COPY apps/discord-forwarder ./apps/discord-forwarder
# bun does not hoist `convex` to the root: it installs one copy per workspace
# that depends on it. Both modules above are compiled from their real paths, so
# each needs its own workspace node_modules or neither `convex/browser` (the
# client) nor `convex/server` (the generated api) resolves.
COPY --from=deps /app/apps/core/node_modules ./apps/core/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
RUN bun build apps/discord-forwarder/src/main.ts --compile --minify --outfile /out/discord-forwarder

FROM alpine:3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
    && addgroup --system --gid 1001 forwarder \
    && adduser --system --uid 1001 forwarder
COPY --from=builder --chown=1001:1001 /out/discord-forwarder ./discord-forwarder
USER 1001
EXPOSE 3000
CMD ["./discord-forwarder"]
