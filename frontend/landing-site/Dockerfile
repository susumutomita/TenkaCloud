FROM node:22-slim
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace package files
COPY frontend/landing-site/package.json ./frontend/landing-site/

# Install dependencies
RUN npm ci

# Copy source code
COPY frontend/landing-site ./frontend/landing-site

# Build
WORKDIR /app/frontend/landing-site
RUN NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack

# Start
CMD ["npm", "start", "--", "--port", "3003"]
