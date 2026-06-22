import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CHALLENGES, createEvalApp } from "@tenkacloud/endpoint-eval";
import type { Hono } from "hono";
import { getEnv } from "../../../helper-functions.js";
import { DdbRunRepository } from "./ddb-run-repository.js";

/**
 * Issue #1973: endpoint-eval Lambda の依存配線 (AWS SDK adapter 層)。
 *
 * `index.ts` (HTTP routing entry) は SDK を直接触らず、 ここで in-memory → DDB / dev 鍵 →
 * SSM SecureString の seam 差し替えを行う (= harness `handler-no-direct-sdk-import` の層分け)。
 * ローカルと**同じ** `createEvalApp` を呼ぶ (engine 共通、 seam だけ差す)。
 */
async function loadSigningSecret(): Promise<string> {
  const param = getEnv("ENDPOINT_EVAL_SIGNING_SECRET_PARAM");
  const ssm = new SSMClient({});
  const res = await ssm.send(new GetParameterCommand({ Name: param, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) {
    // 黙って dev 鍵に倒さない (= no silent fallback)。 鍵が無ければ loud に失敗させる。
    throw new Error(`SSM parameter "${param}" has no value; create it as a SecureString first.`);
  }
  return value;
}

export async function buildApp(): Promise<Hono> {
  const signingSecret = await loadSigningSecret();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const repo = new DdbRunRepository(ddb, getEnv("EVAL_RUNS_TABLE_NAME"));
  return createEvalApp({
    repo,
    challenges: CHALLENGES,
    signingSecret,
    fetchFn: globalThis.fetch,
    now: () => Date.now(),
    newId: () => randomUUID(),
    newSeed: () => randomUUID(),
  });
}
