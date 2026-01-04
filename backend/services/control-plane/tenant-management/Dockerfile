FROM oven/bun:1.2.20-slim AS base
WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy workspace configuration
COPY package.json bun.lock ./
COPY backend/services/shared/dynamodb/package.json backend/services/shared/dynamodb/
COPY backend/services/control-plane/tenant-management/package.json backend/services/control-plane/tenant-management/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY backend/services/shared/dynamodb backend/services/shared/dynamodb
COPY backend/services/control-plane/tenant-management backend/services/control-plane/tenant-management

WORKDIR /app/backend/services/control-plane/tenant-management

# Build the application
RUN bun run build

EXPOSE 3004

CMD ["bun", "run", "start"]
