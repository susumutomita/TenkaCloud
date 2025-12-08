FROM oven/bun:1.2.20 as base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install

# Copy source code and Prisma schema
COPY . .

# Generate Prisma Client
RUN bunx prisma generate

# Build the application
RUN bun run build

# Start the application
CMD ["bun", "run", "start"]
