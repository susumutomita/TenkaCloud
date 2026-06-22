import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EvaluationRecord, RunRecord, RunRepository } from "@tenkacloud/endpoint-eval";

/**
 * Issue #1973: パッケージの {@link RunRepository} を DynamoDB で実装する (= クラウド側 seam)。
 * パッケージ本体は AWS 非依存のまま (in-memory のみ)。 engine から見える interface は同一。
 *
 * Key 設計 ({@link EvalRunsTable} と一致):
 *   RUN#<runId> / META            — run
 *   RUN#<runId> / EVAL#<evalId>   — evaluation
 *   RUN#<runId> / PASS#<stageId>  — 合格 stage の冪等ポインタ (full record を複製保存)
 *
 * 行は `expiresAt` (epoch 秒) で TTL 失効する (= 無料・短命の体験用途)。
 */
export class DdbRunRepository implements RunRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
    /** TTL までの秒数 (既定 7 日)。 */
    private readonly ttlSeconds = 7 * 24 * 60 * 60,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private expiresAt(): number {
    return Math.floor(this.now() / 1000) + this.ttlSeconds;
  }

  private async put(item: Record<string, unknown>): Promise<void> {
    await this.ddb.send(
      new PutCommand({ TableName: this.tableName, Item: { ...item, expiresAt: this.expiresAt() } }),
    );
  }

  private async get(pk: string, sk: string): Promise<Record<string, unknown> | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk } }),
    );
    return (res.Item as Record<string, unknown> | undefined) ?? null;
  }

  async createRun(rec: RunRecord): Promise<void> {
    await this.put({
      PK: `RUN#${rec.runId}`,
      SK: "META",
      runId: rec.runId,
      challengeId: rec.challengeId,
      seed: rec.seed,
      createdAt: rec.createdAt,
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const item = await this.get(`RUN#${runId}`, "META");
    if (!item) return null;
    return {
      runId: item.runId as string,
      challengeId: item.challengeId as string,
      seed: item.seed as string,
      createdAt: item.createdAt as number,
    };
  }

  private toEvaluation(item: Record<string, unknown> | null): EvaluationRecord | null {
    if (!item) return null;
    return {
      evaluationId: item.evaluationId as string,
      runId: item.runId as string,
      stageId: item.stageId as string,
      status: item.status as EvaluationRecord["status"],
      result: item.result as EvaluationRecord["result"],
      clearCode: item.clearCode as string | undefined,
      createdAt: item.createdAt as number,
    };
  }

  async putEvaluation(rec: EvaluationRecord): Promise<void> {
    const body = {
      runId: rec.runId,
      evaluationId: rec.evaluationId,
      stageId: rec.stageId,
      status: rec.status,
      result: rec.result,
      ...(rec.clearCode === undefined ? {} : { clearCode: rec.clearCode }),
      createdAt: rec.createdAt,
    };
    await this.put({ PK: `RUN#${rec.runId}`, SK: `EVAL#${rec.evaluationId}`, ...body });
    // 合格時は stageId ごとの冪等ポインタにも同じ record を書く (= GetItem 1 発で再発行を抑止)。
    if (rec.status === "passed") {
      await this.put({ PK: `RUN#${rec.runId}`, SK: `PASS#${rec.stageId}`, ...body });
    }
  }

  async getEvaluation(runId: string, evaluationId: string): Promise<EvaluationRecord | null> {
    return this.toEvaluation(await this.get(`RUN#${runId}`, `EVAL#${evaluationId}`));
  }

  async findPassedEvaluation(runId: string, stageId: string): Promise<EvaluationRecord | null> {
    return this.toEvaluation(await this.get(`RUN#${runId}`, `PASS#${stageId}`));
  }
}
