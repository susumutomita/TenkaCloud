import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsQueryPort } from "../../control-data/deployments-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { resolveDeploymentsRepository } from "./shared.js";

const MIN_RUNTIME_SCORE_POINTS = -2_147_483_648;
const MAX_RUNTIME_SCORE_POINTS = 2_147_483_647;
const MAX_SCORE_FEED_BATCH = 100;

export interface RuntimeScoreFeedConfig {
  readonly eventId: string;
  readonly deploymentsTableName: string;
  readonly runtimeProblemIds: readonly string[];
  readonly controlPlaneUrl: string;
  readonly tokenParameterName: string;
}

export interface RuntimeScoreFeedDependencies {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly ssm: Pick<SSMClient, "send">;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Re-materialize one event's authoritative Battle score per team and push it to the Workers
 * control plane. Raw per-tick score events stay in DynamoDB for archive; only the bounded team
 * summary crosses the runtime/control-plane seam.
 */
export async function publishRuntimeScoreFeed(
  config: RuntimeScoreFeedConfig,
  dependencies: RuntimeScoreFeedDependencies,
): Promise<void> {
  if (config.runtimeProblemIds.length === 0) return;
  const scoresByTeam = new Map<string, number>();
  const runtimeProblemIds = new Set(config.runtimeProblemIds);
  // [Issue #2441 / Phase B3] `forEachRuntimeScoreFeedPage` absorbs the
  // 200-per-page, `ConsistentRead` Scan + `LastEvaluatedKey` drain into the
  // Deployments seam; the per-row aggregation below is unchanged.
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository({
    ddb: dependencies.ddb,
    deploymentsTableName: config.deploymentsTableName,
  });
  await repository.forEachRuntimeScoreFeedPage(config.eventId, async (page) => {
    for (const row of page as Partial<DeploymentItem>[]) {
      if (
        row.eventId !== config.eventId ||
        typeof row.teamId !== "string" ||
        typeof row.problemId !== "string" ||
        !runtimeProblemIds.has(row.problemId)
      ) {
        continue;
      }
      const points = row.score;
      if (
        typeof points !== "number" ||
        !Number.isSafeInteger(points) ||
        points < MIN_RUNTIME_SCORE_POINTS ||
        points > MAX_RUNTIME_SCORE_POINTS
      ) {
        throw new Error(`invalid runtime score for team ${row.teamId}`);
      }
      const total = (scoresByTeam.get(row.teamId) ?? 0) + points;
      if (
        !Number.isSafeInteger(total) ||
        total < MIN_RUNTIME_SCORE_POINTS ||
        total > MAX_RUNTIME_SCORE_POINTS
      ) {
        throw new Error(`runtime score overflow for team ${row.teamId}`);
      }
      scoresByTeam.set(row.teamId, total);
    }
  });
  if (scoresByTeam.size === 0) return;

  const parameter = await dependencies.ssm.send(
    new GetParameterCommand({
      Name: config.tokenParameterName,
      WithDecryption: true,
    }),
  );
  const token = parameter.Parameter?.Value;
  if (!token) throw new Error("runtime score feed token parameter is empty");

  const endpoint = new URL(
    `/v1/runtime/events/${encodeURIComponent(config.eventId)}/score-summaries`,
    ensureTrailingSlash(config.controlPlaneUrl),
  );
  const scores = Array.from(scoresByTeam, ([teamId, points]) => ({ teamId, points }));
  for (let offset = 0; offset < scores.length; offset += MAX_SCORE_FEED_BATCH) {
    const response = await (dependencies.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scores: scores.slice(offset, offset + MAX_SCORE_FEED_BATCH),
      }),
    });
    if (!response.ok) {
      throw new Error(`runtime score feed rejected with HTTP ${response.status}`);
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
