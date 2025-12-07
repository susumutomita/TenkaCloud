FROM oven/bun:1.2.20
WORKDIR /app

# Copy root package files
COPY package.json bun.lock ./

# Copy workspace package files
COPY frontend/admin-app/package.json ./frontend/admin-app/
COPY frontend/shared/package.json ./frontend/shared/

# Install dependencies (including devDependencies for build)
RUN bun install

# Copy source code
COPY frontend/admin-app ./frontend/admin-app
COPY frontend/shared ./frontend/shared

# Build
WORKDIR /app/frontend/admin-app
RUN bun run build

# Start
CMD ["bun", "start", "--port", "3001"]
