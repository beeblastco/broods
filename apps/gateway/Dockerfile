# Build from the monorepo root: docker build -f apps/gateway/Dockerfile .
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/docs/package.json ./apps/docs/
COPY apps/gateway/package.json ./apps/gateway/
COPY packages/convex/package.json ./packages/convex/
COPY packages/broods/package.json ./packages/broods/
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/core/node_modules ./apps/core/node_modules
COPY --from=deps /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY package.json bun.lock ./
COPY packages/broods ./packages/broods
COPY apps/core/src/shared/nats.ts ./apps/core/src/shared/nats.ts
COPY apps/core/src/shared/object.ts ./apps/core/src/shared/object.ts
COPY apps/core/src/shared/terminal-ticket.ts ./apps/core/src/shared/terminal-ticket.ts
COPY apps/gateway ./apps/gateway
RUN bun build apps/gateway/src/main.ts --compile --minify --outfile /out/gateway

FROM alpine:3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
    && addgroup --system --gid 1001 gateway \
    && adduser --system --uid 1001 gateway
COPY --from=builder --chown=1001:1001 /out/gateway ./gateway
USER 1001
EXPOSE 3000
CMD ["./gateway"]
