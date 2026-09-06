import { ulid } from "ulid";
import { buildScoreEventRecord } from "../handlers/shared/score-event.js";
import type { MutableDeploymentRecord } from "./sql-deployments-core.js";
import {
  DEPLOYMENT_MUTATE_SET,
  deploymentFromPayload,
  deploymentMutateParams,
  ensureNumber,
  getSolvedFlagSet,
  INBOX_EVENT_SK_PREFIX,
  inboxEventFromPayload,
  isUniqueConstraintViolation,
  normalizeJsonValue,
  SCORE_EVENT_SK_PREFIX,
  type SqlDeploymentsCore,
  sameJsonValue,
  scoreEventFromPayload,
} from "./sql-deployments-core.js";
import type {
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentsRepository,
  DeploymentsScoringPort,
  InboxEventRecord,
  ScoreEventRecord,
  SqlStatement,
} from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsScoringPort} adapter — score mutations plus the score-event and inbox sub-aggregates,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 */
export class SqlDeploymentsScoring implements DeploymentsScoringPort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]> {
    if (opts.maxPages !== undefined && opts.maxPages <= 0) return [];
    const limit = opts.maxPages === undefined ? undefined : opts.pageSize * opts.maxPages;
    const rows =
      limit === undefined
        ? await this.core.selectRows(
            "SELECT payload FROM deployment_score_events WHERE job_id = ? AND record_type = ? " +
              "ORDER BY sk DESC",
            [jobId, "score"],
          )
        : await this.core.selectRows(
            "SELECT payload FROM deployment_score_events WHERE job_id = ? AND record_type = ? " +
              "ORDER BY sk DESC LIMIT ?",
            [jobId, "score", limit],
          );
    return rows.map((row) => scoreEventFromPayload(row.payload));
  }

  async listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployment_score_events WHERE job_id = ? AND sk BETWEEN ? AND ? " +
        "ORDER BY sk DESC",
      [jobId, fromSk, toSk],
    );
    return rows.map((row) => scoreEventFromPayload(row.payload));
  }

  async listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]> {
    const rows = await this.core.selectRows(
      "SELECT payload FROM deployment_score_events WHERE job_id = ? AND sk BETWEEN ? AND ? " +
        "ORDER BY sk DESC",
      [jobId, fromSk, toSk],
    );
    return rows.map((row) => inboxEventFromPayload(row.payload));
  }

  async applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) => !getSolvedFlagSet(record as MutableDeploymentRecord).has(flagId),
      mutate: (record) => {
        record.score = ensureNumber(record.score) + points;
        record.solvedFlagIds = new Set([...getSolvedFlagSet(record), flagId]);
        record.lastScoredAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) => !getSolvedFlagSet(record as MutableDeploymentRecord).has(flagId),
      mutate: (record) => {
        record.wrongAnswerCount = ensureNumber(record.wrongAnswerCount) + 1;
        record.score = ensureNumber(record.score) - penalty;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) => record.flagSubmitted !== true,
      mutate: (record) => {
        record.wrongAnswerCount = ensureNumber(record.wrongAnswerCount) + 1;
        record.score = ensureNumber(record.score) - penalty;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) => record.flagSubmitted !== true,
      mutate: (record) => {
        record.score = ensureNumber(record.score) + points;
        record.flagSubmitted = true;
        record.lastScoredAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyHintPenalty(
    jobId: string,
    hint: Parameters<DeploymentsRepository["applyHintPenalty"]>[1],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) =>
        !(record.hintsRevealed ?? []).some((entry) => sameJsonValue(entry, hint)),
      mutate: (record) => {
        record.hintsRevealed = [...(record.hintsRevealed ?? []), hint];
        record.updatedAt = at;
        record.score = ensureNumber(record.score) - Number(hint.penaltyApplied ?? 0);
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        record.displayTeamName = name;
        record.updatedAt = at;
      },
      onMiss: "conflict",
      withPostImage: true,
    });
  }

  async applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        if (result.scoreDelta !== 0) record.score = ensureNumber(record.score) + result.scoreDelta;
        record.lastScoredAt = at;
        record.updatedAt = at;
        if (result.lastResult) record.lastResult = result.lastResult;
        if (result.endpointsHealthJson !== undefined)
          record.endpointsHealth = result.endpointsHealthJson;
        if (result.attackProbesJson !== undefined) record.attackProbes = result.attackProbesJson;
        if (result.postureJson !== undefined) record.posture = result.postureJson;
        if (result.platform !== undefined) record.platform = result.platform;
        if (result.newState !== undefined) record.scoringState = JSON.stringify(result.newState);
      },
      onMiss: "conflict",
    });
  }

  async latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: (record) => record.gateCompletedAt === undefined,
      mutate: (record) => {
        record.gateCompletedAt = at;
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.core.getDeploymentRow(parent.jobId);
      if (!row) return { outcome: "conflict" };
      const record = deploymentFromPayload(row.payload) as MutableDeploymentRecord;
      if (record.gateBonusAwardedAt !== undefined) return { outcome: "conflict" };
      record.score = ensureNumber(record.score) + bonus;
      record.gateBonusAwardedAt = at;
      record.updatedAt = at;
      const scoreEvent = buildScoreEventRecord(parent, "gate-bonus", bonus, at);
      const statements: SqlStatement[] = [
        {
          // [#2672] Rebuilt from payload (credential-stripped), so preserve login_key_hash.
          sql: `UPDATE deployments SET ${DEPLOYMENT_MUTATE_SET} WHERE job_id = ? AND payload = ?`,
          params: [...deploymentMutateParams(record), parent.jobId, String(row.payload)],
        },
        {
          // A missed UPDATE must abort the batch before its score event can be
          // inserted. Use the existing NOT NULL constraint, as coordination does.
          sql: "INSERT INTO deployment_score_events (job_id, sk, record_type, payload) SELECT 'gate-bonus-cas', '', 'score', NULL WHERE changes() <> 1",
        },
        {
          sql:
            "INSERT INTO deployment_score_events " +
            "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
          params: [
            parent.jobId,
            `${SCORE_EVENT_SK_PREFIX}${at}#${ulid()}`,
            "score",
            at,
            Number(parent.expiresAt ?? 0),
            JSON.stringify(normalizeJsonValue(scoreEvent)),
          ],
        },
      ];
      try {
        await this.core.sql.batch(statements);
        return { outcome: "updated" };
      } catch (err) {
        if (
          err instanceof Error &&
          /NOT NULL constraint failed: deployment_score_events.payload/.test(err.message)
        )
          continue;
        if (isUniqueConstraintViolation(err)) return { outcome: "conflict" };
        throw err;
      }
    }
    return { outcome: "conflict" };
  }

  async setScoringState(
    jobId: string,
    stateJson: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.core.mutateExisting({
      jobId,
      predicate: () => true,
      mutate: (record) => {
        record.scoringState = stateJson;
        record.updatedAt = at;
      },
      onMiss: "conflict",
    });
  }

  async appendScoreEvent(record: ScoreEventRecord): Promise<void> {
    await this.core.sql.run(
      "INSERT INTO deployment_score_events " +
        "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      [
        record.jobId,
        `${SCORE_EVENT_SK_PREFIX}${record.occurredAt}#${ulid()}`,
        "score",
        record.occurredAt,
        Number(record.expiresAt ?? 0),
        JSON.stringify(normalizeJsonValue(record)),
      ],
    );
  }

  async appendInboxEvent(jobId: string, inboxId: string, record: InboxEventRecord): Promise<void> {
    const payload = {
      eventId: record.eventId,
      fromTeamId: record.fromTeamId,
      fromJobId: record.fromJobId,
      kind: record.kind,
      payload: record.payload ?? {},
      occurredAt: record.occurredAt,
      ttl: record.ttl,
    };
    await this.core.sql.run(
      "INSERT INTO deployment_score_events " +
        "(job_id, sk, record_type, occurred_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      [
        jobId,
        `${INBOX_EVENT_SK_PREFIX}${record.occurredAt}#${inboxId}`,
        "inbox",
        record.occurredAt ?? null,
        Number(record.ttl ?? 0),
        JSON.stringify(normalizeJsonValue(payload)),
      ],
    );
  }
}
