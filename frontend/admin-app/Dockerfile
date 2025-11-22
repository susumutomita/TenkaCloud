FROM oven/bun:1.2.20
WORKDIR /app

# Copy root package files
COPY package.json bun.lockb ./

# Copy workspace package files
COPY frontend/admin-app/package.json ./frontend/admin-app/

# Install dependencies (including devDependencies for build)
RUN bun install

# Copy source code
COPY frontend/admin-app ./frontend/admin-app

# Build
WORKDIR /app/frontend/admin-app
RUN bun run build

# Start
CMD ["bun", "start", "--port", "3001"]
