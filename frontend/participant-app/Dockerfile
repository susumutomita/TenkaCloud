FROM node:22-slim
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace package files
COPY frontend/participant-app/package.json ./frontend/participant-app/

# Install dependencies
RUN npm ci

# Copy source code
COPY frontend/participant-app ./frontend/participant-app

# Build
WORKDIR /app/frontend/participant-app
RUN npm run build

# Start
CMD ["npm", "start", "--", "--port", "3002"]
