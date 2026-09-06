import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import {
  type CoordinationScoreDelivery,
  publicCoordinationScoreReason,
} from "../../control-data/domain/coordination-score.js";
import type { DeploymentRecord, DeploymentsRepository } from "../../control-data/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { buildScoreEventRecord } from "../shared/score-event.js";
import type { CoordinationStateRow, CoordinationStoreDeps } from "./coordination-store.js";
import { resolveDeploymentsRepository } from "./shared.js";

/** The plugin's numeric score is authoritative. Invalid hooks refuse the transition before saving it. */
export function coordinationScoreDelivery<State, Op, Projection>(
  plugin: CoordinationPlugin<State, Op, Projection>,
  before: State,
  after: State,
  cause:
    | { readonly kind: "op"; readonly teamId: string; readonly op: Op }
    | { readonly kind: "tick" },
  occurredAt: string,
): CoordinationScoreDelivery | undefined {
  if (!plugin.teamScores) return undefined;
  const previous = plugin.teamScores(before);
  const current = plugin.teamScores(after);
  const reasons = plugin.scoreReasons?.(before, after, cause);
  const teams: Record<string, CoordinationScoreDelivery["teams"][string]> = {};
  for (const [teamId, score] of Object.entries(current)) {
    const oldScore = previous[teamId] ?? 0;
    if (!Number.isFinite(score) || !Number.isFinite(oldScore))
      throw new Error("Invalid coordination score");
    if (score === oldScore) continue;
    teams[teamId] = {
      before: oldScore,
      score,
      reason: publicCoordinationScoreReason(reasons?.[teamId]),
    };
  }
  return Object.keys(teams).length ? { occurredAt, teams } : undefined;
}

/**
 * Drain the durable delivery BEFORE accepting another transition. Every team is a small atomic
 * score + history transaction, so the DynamoDB 100-item cap does not restrict the event roster.
 * A crash after any subset leaves this same batch in the versioned state row. Replaying it is
 * harmless because each deployment carries the run and version it has already received.
 */
export async function deliverCoordinationScores(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  row: CoordinationStateRow | undefined,
): Promise<void> {
  if (!row?.pendingScores) return;
  const repository = await resolveDeploymentsRepository(store);
  const delivery = row.pendingScores;
  const candidates = await repository.listByTenantAndEvent(scope.tenantId, scope.eventId);
  for (const [teamId, change] of Object.entries(delivery.teams)) {
    const jobs = candidates.filter((candidate) => matchesTeam(candidate, scope, teamId));
    // Retired rows are evidence, not missing data. Keep their final score while the remaining
    // teams continue playing. An absent index result alone cannot prove that a team retired.
    if (!jobs.length) throw new Error("Coordination score delivery has no deployment");
    for (const candidate of jobs) {
      await publishJobScore(repository, candidate.jobId, {
        scope,
        teamId,
        change,
        version: row.version,
        occurredAt: delivery.occurredAt,
      });
    }
  }

  await repository.acknowledgeCoordinationScores(scope, row.version);
}

function matchesTeam(
  deployment: DeploymentRecord | undefined,
  scope: CoordinationStateScope,
  teamId: string,
): deployment is DeploymentRecord {
  return (
    deployment !== undefined &&
    deployment.tenantId === scope.tenantId &&
    deployment.eventId === scope.eventId &&
    deployment.problemId === scope.problemId &&
    deployment.teamId === teamId
  );
}

async function publishJobScore(
  repository: Pick<DeploymentsRepository, "getDeployment" | "publishCoordinationScore">,
  jobId: string,
  input: {
    readonly scope: CoordinationStateScope;
    readonly teamId: string;
    readonly change: CoordinationScoreDelivery["teams"][string];
    readonly version: number;
    readonly occurredAt: string;
  },
): Promise<void> {
  const { scope, teamId, change } = input;
  // Query indexes may lag. The subsequent transaction checks this exact score and all scope fields.
  const deployment = await repository.getDeployment(jobId);
  if (!matchesTeam(deployment, scope, teamId))
    throw new Error("Coordination score deployment scope changed");
  if (deployment.teardownRequestedAt || DELETED_LIKE_STATUSES.has(deployment.status)) return;
  if (
    deployment.coordinationScoreRunId === scope.runId &&
    Number(deployment.coordinationScoreVersion ?? 0) >= input.version
  )
    return;
  const current = typeof deployment.score === "number" ? deployment.score : undefined;
  const event = {
    ...buildScoreEventRecord(
      deployment,
      "coordination",
      change.score - change.before,
      input.occurredAt,
    ),
    reason: change.reason,
  };
  // A legacy scoreboard may already disagree with game state. Explain that repair separately
  // instead of labelling it as points earned by this operation.
  const repair = change.before - (current ?? 0);
  const events =
    repair === 0
      ? [event]
      : [
          {
            ...buildScoreEventRecord(deployment, "coordination", repair, input.occurredAt),
            reason: "sync",
          },
          event,
        ];
  const result = await repository.publishCoordinationScore(scope, input.version, {
    jobId: deployment.jobId,
    teamId,
    expectedScore: current,
    expectedStatus: deployment.status,
    score: change.score,
    events,
  });
  if (result.outcome !== "updated")
    throw new Error("Coordination score delivery conflicted; retry the saved batch");
}

/** A committed move stays committed even when delivery needs the next tick to retry it. */
export async function tryDeliverCoordinationScores(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  row: CoordinationStateRow,
): Promise<void> {
  await deliverCoordinationScores(store, scope, row).catch(() => {
    console.warn("[coordination] score delivery pending; next tick retries", {
      tenantId: scope.tenantId,
      eventId: scope.eventId,
      problemId: scope.problemId,
      runId: scope.runId,
      version: row.version,
    });
  });
}
