# users service — Microservice Migration Battle (Phase 1)
#
# Node.js 20 Alpine ベース。3 サービス共通の構成。
# Lambda + API Gateway / ECS Fargate / App Runner のいずれにも乗せられる:
#   - Lambda: hono/aws-lambda adapter を追加 + entrypoint を handler に変える
#   - ECS Fargate / App Runner: 本 Dockerfile を ECR push → そのまま起動
#
# 競技中の再デプロイ高速化のため、依存と src を別レイヤに分けている。

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# 依存だけ先に解決 (lockfile を後で添付する手も検討中)
RUN npm install --omit=optional --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY package.json ./

EXPOSE 3001
# tsx で TypeScript を直接実行 (ビルド工程不要)。
# Lambda 移行時は `node` + transpile 済み JS に切り替えるか、esbuild bundle を使う。
CMD ["npx", "tsx", "src/index.ts"]
