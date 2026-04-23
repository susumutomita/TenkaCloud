FROM oven/bun:1.2.20-slim AS base
WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy repo (dockerignore should exclude node_modules etc.)
COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

WORKDIR /app/server/microservices/problem-service

# Generate Prisma client
RUN bunx prisma generate

# Build the application (TypeScript compiler)
RUN bun run build

EXPOSE 3100

CMD ["bun", "run", "start"]
