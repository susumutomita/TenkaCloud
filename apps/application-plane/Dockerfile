FROM oven/bun:1.2.20
WORKDIR /app

# Copy root package files
COPY package.json bun.lock ./

# Copy workspace package files
COPY frontend/participant-app/package.json ./frontend/participant-app/
COPY frontend/shared/package.json ./frontend/shared/

# Install dependencies
RUN bun install

# Copy source code
COPY frontend/participant-app ./frontend/participant-app
COPY frontend/shared ./frontend/shared

# Build
WORKDIR /app/frontend/participant-app
RUN bun run build

# Start
CMD ["bun", "start", "--port", "3002"]
