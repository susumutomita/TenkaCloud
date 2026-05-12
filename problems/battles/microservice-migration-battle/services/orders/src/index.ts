// orders service — Microservice Migration Battle (Phase 1)
//
// 構造は users / catalog と同型。詳細は users/src/index.ts のヘッダを参照。

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const SERVICE_NAME = "orders" as const;
const PORT = Number.parseInt(process.env.PORT ?? "3002", 10);
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
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return c.json({ score: computeLegacyScore() });
  }
  return c.json({ score: computeScore() });
});

app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE_NAME }));

function computeScore(): number {
  return 7;
}

function computeLegacyScore(): number {
  return 7;
}

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`[${SERVICE_NAME}] listening on :${info.port} (platform=${PLATFORM})`);
  },
);
