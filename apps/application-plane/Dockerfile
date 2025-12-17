FROM oven/bun:1.2.20 AS deps
WORKDIR /app

# Copy workspace manifests
COPY bun.lock package.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/application-plane/package.json apps/application-plane/
COPY apps/landing-site/package.json apps/landing-site/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/

RUN bun install --frozen-lockfile

FROM oven/bun:1.2.20 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/package.json ./package.json
COPY apps/application-plane ./apps/application-plane
COPY packages ./packages

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV SKIP_AUTH0_VALIDATION=1
ENV AUTH0_CLIENT_ID=dummy-client-id
ENV AUTH0_CLIENT_SECRET=dummy-client-secret
ENV AUTH0_ISSUER=https://example.com

WORKDIR /app/apps/application-plane
RUN bun run build

FROM oven/bun:1.2.20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/application-plane/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/application-plane/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/application-plane/.next/static ./.next/static

USER nextjs

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

CMD ["bun", "server.js"]
