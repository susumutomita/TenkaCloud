FROM oven/bun:1.2.20
WORKDIR /app

# Copy root package files
COPY package.json bun.lockb ./

# Copy workspace package files
COPY frontend/landing-site/package.json ./frontend/landing-site/

# Install dependencies
RUN bun install

# Copy source code
COPY frontend/landing-site ./frontend/landing-site

# Build
WORKDIR /app/frontend/landing-site
RUN NEXT_TELEMETRY_DISABLED=1 bun run build -- --webpack

# Start
CMD ["bun", "start", "--port", "3003"]
