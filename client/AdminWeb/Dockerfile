# TenkaCloud Control Plane UI - multi-stage Docker build using repo root context

# Stage 1: Dependencies
FROM oven/bun:1.2.20 AS deps
WORKDIR /app

# Copy repo (dockerignore should exclude node_modules etc.)
COPY . .

RUN bun install --frozen-lockfile --ignore-scripts

# Stage 2: Builder
FROM oven/bun:1.2.20 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/package.json ./package.json
COPY client/AdminWeb ./client/AdminWeb
COPY packages ./packages

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV SKIP_AUTH0_VALIDATION=1
ENV AUTH0_CLIENT_ID=dummy-client-id
ENV AUTH0_CLIENT_SECRET=dummy-client-secret
ENV AUTH0_ISSUER=https://example.com

WORKDIR /app/client/AdminWeb
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
COPY --from=builder /app/client/AdminWeb/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/client/AdminWeb/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/client/AdminWeb/.next/static ./.next/static

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 13000

ENV PORT=13000
ENV HOSTNAME="0.0.0.0"

# Start the application
CMD ["bun", "server.js"]
