# Build from the monorepo root: docker build -f apps/discord-forwarder/Dockerfile .
# Pin the digest: the version tag is republished when the base image rebuilds.
# checkov:skip=CKV_DOCKER_7:BUN_IMAGE defaults to a version and immutable digest; the scanner does not resolve ARG in FROM.
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

FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/discord-forwarder/node_modules ./apps/discord-forwarder/node_modules
COPY package.json bun.lock ./
# The one core module the forwarder imports by relative path. It has no imports
# of its own. Rename it and this build breaks. `packages/convex` is only ever a
# type import here, so the bundle needs none of it.
COPY apps/core/src/shared/env.ts ./apps/core/src/shared/env.ts
COPY apps/discord-forwarder ./apps/discord-forwarder
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["./discord-forwarder", "--healthcheck"]
CMD ["./discord-forwarder"]
