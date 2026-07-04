# Self-hosted core runtime image (epic #85 phase 9a): one Bun binary serving
# both harness-processing and account-manage over HTTP, routed by Host header.
# Build from the monorepo root: docker build -f apps/core/Dockerfile .
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/docs/package.json ./apps/docs/
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/convex/package.json ./packages/convex/
COPY packages/broods/package.json ./packages/broods/
# --ignore-scripts skips core's `sst install` postinstall; system prompts are
# generated explicitly in the builder stage instead.
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/core/node_modules ./apps/core/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
COPY package.json bun.lock ./
# The storage adapter require()s @broods/convex/_generated/api (committed).
COPY packages/convex ./packages/convex
COPY apps/core ./apps/core
# Compile at the default (x64) target: the k3s cluster nodes are amd64.
RUN cd apps/core && bun run scripts/system-prompt.ts \
    && bun build --compile --target=bun-linux-x64 --minify src/server.ts --outfile /out/core-server

FROM alpine:3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
    && addgroup --system --gid 1001 core \
    && adduser --system --uid 1001 core
COPY --from=builder --chown=1001:1001 /out/core-server ./core-server
USER 1001
EXPOSE 3000
CMD ["./core-server"]
