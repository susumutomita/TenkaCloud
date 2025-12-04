FROM node:22-slim
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace package files
COPY frontend/admin-app/package.json ./frontend/admin-app/

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY frontend/admin-app ./frontend/admin-app

# Build
WORKDIR /app/frontend/admin-app
RUN npm run build

# Start
CMD ["npm", "start", "--", "--port", "3001"]
