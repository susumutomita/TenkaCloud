import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { type ChallengeDefinition, publicStages } from "./challenge.js";
import { type ClearCodeClaims, issueClearCode, verifyClearCode } from "./clear-code.js";
import type { ProbeContext } from "./probe.js";
import type { EvaluationRecord, RunRepository } from "./run-store.js";
import { evaluateStage } from "./stage.js";
import { guardTargetUrl } from "./target-guard.js";

/**
 * Issue #1973: 外部エンドポイント評価バックエンドの Hono app。
 *
 * `app.fetch` はランタイム非依存 — ローカルは `Bun.serve({ fetch: app.fetch })`、
 * クラウドは `hono/aws-lambda` の `handle(app)` でそのまま動く (= "Kumo で動くか" の答え)。
 * 副作用 (時刻 / id / nonce / fetch / 永続化) はすべて {@link EvalAppDeps} で注入するので
 * 決定的にテストできる。
 *
 * routes:
 *   GET  /healthz
 *   POST /runs                                  { challengeId } → run 作成 (公開 stage 一覧)
 *   POST /runs/:runId/evaluations               { stage, endpoint } → 同期評価 + 合格時クリアコード
 *   GET  /runs/:runId/evaluations/:evaluationId → 評価結果取得
 *   POST /clear-codes/verify                    { code } → 署名 + 失効検証 (回答提出側)
 */
export interface EvalAppDeps {
  readonly repo: RunRepository;
  /** id → challenge 定義 (= 問題 plugin)。 隠しテストはこの中に閉じる。 */
  readonly challenges: Readonly<Record<string, ChallengeDefinition>>;
  readonly signingSecret: string;
  readonly fetchFn: typeof fetch;
  readonly now: () => number;
  /** runId / evaluationId / nonce を生成する。 */
  readonly newId: () => string;
  /** run の seed を生成する (probe 入力の run 間変動に使う)。 */
  readonly newSeed: () => string;
  readonly clearCodeTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

const CreateRunSchema = z.object({ challengeId: z.string().min(1) });
const EvaluateSchema = z.object({ stage: z.string().min(1), endpoint: z.string().min(1) });
const VerifySchema = z.object({ code: z.string().min(1) });

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY = 256 * 1024;

/** evaluation record から参加者へ返す安全な表現 (probe の安全 detail のみ)。 */
function toEvaluationView(rec: EvaluationRecord) {
  return {
    evaluationId: rec.evaluationId,
    runId: rec.runId,
    stageId: rec.stageId,
    status: rec.status,
    passed: rec.status === "passed",
    probes: rec.result.probes.map((p) => ({
      id: p.id,
      passed: p.passed,
      description: p.description,
      detail: p.detail,
    })),
    clearCode: rec.clearCode,
  };
}

export function createEvalApp(deps: EvalAppDeps): Hono {
  const app = new Hono();
  const ttl = deps.clearCodeTtlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  app.get("/healthz", (c) => c.json({ ok: true }, StatusCodes.OK));

  app.post("/runs", async (c) => {
    const parsed = CreateRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "challengeId は必須です" }, StatusCodes.BAD_REQUEST);
    }
    const challenge = deps.challenges[parsed.data.challengeId];
    if (!challenge) {
      return c.json({ error: "未知の challengeId です" }, StatusCodes.NOT_FOUND);
    }
    const runId = deps.newId();
    await deps.repo.createRun({
      runId,
      challengeId: challenge.id,
      seed: deps.newSeed(),
      createdAt: deps.now(),
    });
    return c.json(
      { runId, challengeId: challenge.id, title: challenge.title, stages: publicStages(challenge) },
      StatusCodes.CREATED,
    );
  });

  app.post("/runs/:runId/evaluations", async (c) => {
    const run = await deps.repo.getRun(c.req.param("runId"));
    if (!run) return c.json({ error: "run が見つかりません" }, StatusCodes.NOT_FOUND);

    const parsed = EvaluateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "stage と endpoint は必須です" }, StatusCodes.BAD_REQUEST);
    }
    const challenge = deps.challenges[run.challengeId];
    // run は存在するチャレンジでしか作られないため challenge は必ず存在する。
    const stage = challenge.stages.find((s) => s.id === parsed.data.stage);
    if (!stage) return c.json({ error: "未知の stage です" }, StatusCodes.NOT_FOUND);

    const guarded = guardTargetUrl(parsed.data.endpoint, challenge.targetPolicy);
    if (!guarded.ok) {
      return c.json(
        { error: `endpoint を受理できません: ${guarded.reason}` },
        StatusCodes.BAD_REQUEST,
      );
    }

    const ctx: ProbeContext = {
      fetchFn: deps.fetchFn,
      values: challenge.makeRunValues?.(run.seed) ?? {},
      timeoutMs,
      maxBodyBytes,
    };
    const result = await evaluateStage(guarded.url, stage, ctx);

    if (!result.passed) {
      const rec: EvaluationRecord = {
        evaluationId: deps.newId(),
        runId: run.runId,
        stageId: stage.id,
        status: "failed",
        result,
        createdAt: deps.now(),
      };
      await deps.repo.putEvaluation(rec);
      return c.json(toEvaluationView(rec), StatusCodes.OK);
    }

    // 合格: 同 stage で既に発行済みなら冪等に同じクリアコードを返す。
    const existing = await deps.repo.findPassedEvaluation(run.runId, stage.id);
    if (existing) {
      return c.json(toEvaluationView(existing), StatusCodes.OK);
    }
    const issuedAt = deps.now();
    const claims: ClearCodeClaims = {
      runId: run.runId,
      challengeId: challenge.id,
      stage: stage.id,
      issuedAt,
      expiresAt: issuedAt + ttl,
      nonce: deps.newId(),
    };
    const rec: EvaluationRecord = {
      evaluationId: deps.newId(),
      runId: run.runId,
      stageId: stage.id,
      status: "passed",
      result,
      clearCode: issueClearCode(claims, deps.signingSecret),
      createdAt: issuedAt,
    };
    await deps.repo.putEvaluation(rec);
    return c.json(toEvaluationView(rec), StatusCodes.OK);
  });

  app.get("/runs/:runId/evaluations/:evaluationId", async (c) => {
    const rec = await deps.repo.getEvaluation(c.req.param("runId"), c.req.param("evaluationId"));
    if (!rec) return c.json({ error: "evaluation が見つかりません" }, StatusCodes.NOT_FOUND);
    return c.json(toEvaluationView(rec), StatusCodes.OK);
  });

  app.post("/clear-codes/verify", async (c) => {
    const parsed = VerifySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "code は必須です" }, StatusCodes.BAD_REQUEST);
    }
    const verified = verifyClearCode(parsed.data.code, deps.signingSecret, deps.now());
    if (!verified.ok) {
      return c.json({ valid: false, reason: verified.reason }, StatusCodes.OK);
    }
    return c.json({ valid: true, claims: verified.claims }, StatusCodes.OK);
  });

  return app;
}
