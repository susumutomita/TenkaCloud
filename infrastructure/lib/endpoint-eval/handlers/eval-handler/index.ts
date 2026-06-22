import type { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { buildApp } from "./build-app.js";

/**
 * Issue #1973: endpoint-eval バックエンドの Lambda エントリ (HTTP routing entry)。
 *
 * ローカル (`packages/endpoint-eval/src/server.ts`) と **同じ Hono app** を、 ここでは
 * `handle(app)` で Lambda に載せる。 AWS SDK 配線 (DDB / SSM 署名鍵) は {@link buildApp}
 * (= adapter 層) に閉じ込め、 この entry は SDK を直接触らない。 署名鍵の SSM 読み取りは
 * 非同期なので app を遅延構築して cold start 後に 1 度だけ作る。
 */
let appPromise: Promise<Hono> | null = null;

export const handler = async (event: LambdaEvent, context: LambdaContext): Promise<unknown> => {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  return handle(app)(event, context);
};
