# Build from the monorepo root: docker build -f apps/dashboard/Dockerfile .
# Pin the digest: the version tag is republished when the base image rebuilds.
ARG BUN_IMAGE=oven/bun:1.4.1-alpine@sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# The lockfile spans every workspace, so each workspace package.json must be
# present for --frozen-lockfile to resolve.
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
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_BROODS_BASE_URL
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI
ENV NEXT_PUBLIC_BROODS_BASE_URL=$NEXT_PUBLIC_BROODS_BASE_URL
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=$NEXT_PUBLIC_WORKOS_REDIRECT_URI
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=deps /app/packages/convex/node_modules ./packages/convex/node_modules
COPY package.json bun.lock ./
COPY packages/convex/ ./packages/convex/
COPY packages/broods/ ./packages/broods/
COPY apps/dashboard/ ./apps/dashboard/
# Convex is deployed separately by .github/workflows/deploy-convex.yaml; this
# build only compiles the Next app against the committed _generated/ types and
# NEXT_PUBLIC_CONVEX_URL.
RUN bun run --cwd apps/dashboard build

FROM ${BUN_IMAGE} AS runner
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
