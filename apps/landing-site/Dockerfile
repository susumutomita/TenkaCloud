FROM oven/bun:1.2.20 AS deps
WORKDIR /app

# Copy workspace manifests
COPY bun.lock package.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/application-plane/package.json apps/application-plane/
COPY apps/landing-site/package.json apps/landing-site/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY backend/services/application-plane/problem-service/package.json backend/services/application-plane/problem-service/
COPY backend/services/application-plane/battle-service/package.json backend/services/application-plane/battle-service/
COPY backend/services/application-plane/scoring-service/package.json backend/services/application-plane/scoring-service/
COPY backend/services/shared/dynamodb/package.json backend/services/shared/dynamodb/
COPY backend/services/control-plane/registration/package.json backend/services/control-plane/registration/
COPY backend/services/control-plane/system-management/package.json backend/services/control-plane/system-management/
COPY backend/services/control-plane/user-management/package.json backend/services/control-plane/user-management/
COPY backend/services/control-plane/deployment-management/package.json backend/services/control-plane/deployment-management/
COPY backend/services/control-plane/tenant-management/package.json backend/services/control-plane/tenant-management/
COPY backend/services/control-plane/provisioning/package.json backend/services/control-plane/provisioning/

RUN bun install --frozen-lockfile

FROM oven/bun:1.2.20 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/package.json ./package.json
COPY apps/landing-site ./apps/landing-site
COPY packages ./packages

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

WORKDIR /app/apps/landing-site
RUN bun run build -- --webpack

FROM oven/bun:1.2.20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/landing-site/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/landing-site/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/landing-site/.next/static ./.next/static

USER nextjs

EXPOSE 3003
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"

CMD ["bun", "server.js"]
