// users service — Microservice Migration Battle (Phase 1)
//
// Hono on Node.js 20. 3 サービス (users / orders / catalog) のうち users 担当。
// Phase 1 では nginx reverse proxy 配下 (/users/*) で listen し、Score Engine が
// `GET /users/score` を 1 分毎 polling する。
//
// このコードは Lambda + API Gateway / ECS Fargate / App Runner のいずれにも
// **そのまま** 乗せ替え可能になっている (= Hono 公式 adapter で互換性確保)。
//   - Lambda: `hono/aws-lambda` adapter で handler 化
//   - ECS Fargate: 本 Dockerfile + ALB Target Group (port 3001)
//   - App Runner: 本 Dockerfile を ECR push → App Runner Service 作成
//
// 競技中に競技者が読むのはこの index.ts と /catalog, /orders 配下の同型コード。
// 同じ shape なので一気に 3 サービス分の Lambda function or App Runner service を
// 作れるようにしておく (= 学習負荷を下げる意図)。

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const SERVICE_NAME = "users" as const;
const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);

// platform 自己申告。Phase 2 score engine が `/meta` を読んで platform を判定する。
// 移行先 (Lambda / ECS / App Runner) では起動時 env で上書きすること。
//   例: Lambda function の env に PLATFORM=lambda、App Runner なら PLATFORM=apprunner
const PLATFORM = (process.env.PLATFORM ?? "ec2") as "ec2" | "lambda" | "ecs" | "apprunner";
const VERSION = "1.0.0";

const app = new Hono();

app.get("/meta", (c) =>
  c.json({
    service: SERVICE_NAME,
    platform: PLATFORM,
    version: VERSION,
  }),
);

app.get("/score", async (c) => {
  // LEGACY_PATH: 本来不要 / Phase 2 で score engine が ?legacy=true に切替予定。
  // 競技者はこの分岐に気づいたら削除して再デプロイする (= 競技の終盤ギミック)。
  const legacy = c.req.query("legacy") === "true";
  if (legacy) {
    // 意図的な 2 秒遅延。SLA 違反を誘発するための仕掛け。
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return c.json({ score: computeLegacyScore() });
  }
  return c.json({ score: computeScore() });
});

app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE_NAME }));

function computeScore(): number {
  // 5 ms 程度で済む軽量計算。Phase 1 では deterministic な値を返す。
  return 42;
}

function computeLegacyScore(): number {
  // legacy 互換用 "重い" 計算。実体は同じ値を返すが、上の await sleep で遅延が出る。
  return 42;
}

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    // 起動時ログを stdout に出して docker logs / CloudWatch Logs から確認できるようにする
    console.log(`[${SERVICE_NAME}] listening on :${info.port} (platform=${PLATFORM})`);
  },
);
