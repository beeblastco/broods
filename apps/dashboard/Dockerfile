# Build from the monorepo root: docker build -f apps/dashboard/Dockerfile .
FROM oven/bun:1.3.3-alpine AS deps
WORKDIR /app
# The lockfile spans every workspace, so each workspace package.json must be
# present for --frozen-lockfile to resolve.
COPY package.json bun.lock ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/docs/package.json ./apps/docs/
COPY packages/convex/package.json ./packages/convex/
COPY packages/filthy-panty/package.json ./packages/filthy-panty/
COPY packages/demos/package.json ./packages/demos/
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.3-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_AGENT_GATEWAY_URL
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI
ENV NEXT_PUBLIC_AGENT_GATEWAY_URL=$NEXT_PUBLIC_AGENT_GATEWAY_URL
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=$NEXT_PUBLIC_WORKOS_REDIRECT_URI
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
COPY package.json bun.lock ./
COPY packages/convex/ ./packages/convex/
COPY apps/dashboard/ ./apps/dashboard/
RUN --mount=type=secret,id=CONVEX_DEPLOY_KEY,env=CONVEX_DEPLOY_KEY \
    cd packages/convex && bunx convex deploy --cmd 'bun run --cwd ../../apps/dashboard build'

FROM oven/bun:1.3.4-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
# Standalone output in a monorepo nests the app under its workspace path.
COPY --from=builder --chown=1001:1001 /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=1001:1001 /app/apps/dashboard/public ./apps/dashboard/public
USER 1001
EXPOSE 3000
CMD ["bun", "apps/dashboard/server.js"]
