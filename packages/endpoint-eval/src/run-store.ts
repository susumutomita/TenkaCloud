import type { StageResult } from "./stage.js";

/**
 * Issue #1973: run / evaluation の永続化 seam。
 *
 * engine は interface だけに依存し、 ローカルは {@link InMemoryRunRepository}、
 * クラウドは DynamoDB 実装を同じ interface で差す (= trust-bridge の store と同じ流儀)。
 * 「同 stage のクリアコード再発行を冪等化」するため {@link RunRepository.findPassedEvaluation}
 * を持つ。
 */
export type EvaluationStatus = "passed" | "failed";

export interface RunRecord {
  readonly runId: string;
  readonly challengeId: string;
  /** run ごとの probe 入力値を導出する seed。 */
  readonly seed: string;
  readonly createdAt: number;
}

export interface EvaluationRecord {
  readonly evaluationId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly status: EvaluationStatus;
  readonly result: StageResult;
  /** 合格時のみ発行される署名付きクリアコード。 */
  readonly clearCode?: string;
  readonly createdAt: number;
}

export interface RunRepository {
  createRun(rec: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  putEvaluation(rec: EvaluationRecord): Promise<void>;
  getEvaluation(runId: string, evaluationId: string): Promise<EvaluationRecord | null>;
  /** 同 (run, stage) で既に合格した評価があれば返す (= クリアコード再発行の冪等化)。 */
  findPassedEvaluation(runId: string, stageId: string): Promise<EvaluationRecord | null>;
}

/** ローカルバックエンド / テスト用の in-memory 実装。 */
export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunRecord>();
  private readonly evaluations = new Map<string, EvaluationRecord>();

  private key(runId: string, evaluationId: string): string {
    return `${runId}#${evaluationId}`;
  }

  async createRun(rec: RunRecord): Promise<void> {
    this.runs.set(rec.runId, rec);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async putEvaluation(rec: EvaluationRecord): Promise<void> {
    this.evaluations.set(this.key(rec.runId, rec.evaluationId), rec);
  }

  async getEvaluation(runId: string, evaluationId: string): Promise<EvaluationRecord | null> {
    return this.evaluations.get(this.key(runId, evaluationId)) ?? null;
  }

  async findPassedEvaluation(runId: string, stageId: string): Promise<EvaluationRecord | null> {
    for (const rec of this.evaluations.values()) {
      if (rec.runId === runId && rec.stageId === stageId && rec.status === "passed") {
        return rec;
      }
    }
    return null;
  }
}
