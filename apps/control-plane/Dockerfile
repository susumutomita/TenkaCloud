# TenkaCloud Control Plane UI - multi-stage Docker build using repo root context

# Stage 1: Dependencies
FROM oven/bun:1.2.20 AS deps
WORKDIR /app

# Copy workspace manifests for deterministic installs
COPY bun.lock package.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/application-plane/package.json apps/application-plane/
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

# Stage 2: Builder
FROM oven/bun:1.2.20 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/package.json ./package.json
COPY apps/control-plane ./apps/control-plane
COPY packages ./packages

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV SKIP_AUTH0_VALIDATION=1
ENV AUTH0_CLIENT_ID=dummy-client-id
ENV AUTH0_CLIENT_SECRET=dummy-client-secret
ENV AUTH0_ISSUER=https://example.com

WORKDIR /app/apps/control-plane
RUN bun run build

# Stage 3: Runner
FROM oven/bun:1.2.20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/apps/control-plane/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/control-plane/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/control-plane/.next/static ./.next/static

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Start the application
CMD ["bun", "server.js"]
