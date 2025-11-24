FROM oven/bun:1 as base
WORKDIR /app

# Install dependencies
COPY package.json .
RUN bun install

# Copy source code
COPY . .

# Build the application
RUN bun run build

# Start the application
CMD ["bun", "run", "start"]
