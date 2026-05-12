# catalog service — Microservice Migration Battle (Phase 1)
# users / orders と同型。詳細は users/Dockerfile のヘッダを参照。

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY package.json ./

EXPOSE 3003
CMD ["npx", "tsx", "src/index.ts"]
