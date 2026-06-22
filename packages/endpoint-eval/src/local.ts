import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { createEvalApp } from "./app.js";
import type { ChallengeDefinition } from "./challenge.js";
import { CHALLENGES } from "./challenges/index.js";
import { InMemoryRunRepository } from "./run-store.js";
import { widenForLocal } from "./target-guard.js";

/**
 * Issue #1973: ローカルバックエンドの組み立て。 in-memory store + node crypto + global fetch を
 * 配線し、 `app.fetch` を返す。 同じ `createEvalApp` をクラウド側は DDB repo + Lambda 配線で
 * 呼ぶ (= engine 共通、 seam だけ差し替え)。
 */
export interface LocalEvalOptions {
  /** クリアコード署名鍵。 未指定なら dev 既定 + 警告 (本番では必ず指定する)。 */
  readonly signingSecret?: string;
  /**
   * 既定 true: 評価対象として localhost / ローカルコンテナ も許す ({@link widenForLocal})。
   * `wrangler dev` の localhost:8787 や docker のローカルアプリを評価したいときに使う。
   */
  readonly allowLocalTargets?: boolean;
  /** 差し替え可能なチャレンジカタログ (既定は同梱の {@link CHALLENGES})。 */
  readonly challenges?: Readonly<Record<string, ChallengeDefinition>>;
}

const DEV_SECRET = "tenkacloud-local-dev-secret-change-me";

function resolveChallenges(
  challenges: Readonly<Record<string, ChallengeDefinition>>,
  allowLocalTargets: boolean,
): Record<string, ChallengeDefinition> {
  if (!allowLocalTargets) return { ...challenges };
  const widened: Record<string, ChallengeDefinition> = {};
  for (const [id, def] of Object.entries(challenges)) {
    widened[id] = { ...def, targetPolicy: widenForLocal(def.targetPolicy) };
  }
  return widened;
}

export function createLocalEvalApp(options: LocalEvalOptions = {}): Hono {
  const signingSecret = options.signingSecret ?? DEV_SECRET;
  if (signingSecret === DEV_SECRET) {
    console.warn(
      "[endpoint-eval] signingSecret 未指定: dev 既定鍵を使用中。 本番では ENDPOINT_EVAL_SIGNING_SECRET を設定してください。",
    );
  }
  const allowLocalTargets = options.allowLocalTargets ?? true;
  return createEvalApp({
    repo: new InMemoryRunRepository(),
    challenges: resolveChallenges(options.challenges ?? CHALLENGES, allowLocalTargets),
    signingSecret,
    fetchFn: globalThis.fetch,
    now: () => Date.now(),
    newId: () => randomUUID(),
    newSeed: () => randomUUID(),
  });
}
