FROM oven/bun:1.2.20
WORKDIR /app

# Copy root package files
COPY package.json bun.lockb ./

# Copy workspace package files
COPY frontend/participant-app/package.json ./frontend/participant-app/

# Install dependencies
RUN bun install

# Copy source code
COPY frontend/participant-app ./frontend/participant-app

# Build
WORKDIR /app/frontend/participant-app
RUN bun run build

# Start
CMD ["bun", "start", "--port", "3002"]
