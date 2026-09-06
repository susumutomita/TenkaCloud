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
  includeUnchangedTeams = false,
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
    if (score === oldScore && !includeUnchangedTeams) continue;
    teams[teamId] = {
      before: oldScore,
      score,
      reason: score === oldScore ? "sync" : publicCoordinationScoreReason(reasons?.[teamId]),
    };
  }
  return Object.keys(teams).length
    ? { occurredAt, teams, ...(includeUnchangedTeams ? { initializing: true as const } : {}) }
    : undefined;
}

/**
 * Drain the durable delivery BEFORE accepting another transition. Every team is a small atomic
 * score + history transaction, so the DynamoDB 100-item cap does not restrict the event roster.
 * A crash after any subset leaves this same batch in the versioned state row. Replaying it is
 * harmless because each deployment carries the run and version it has already received.
 */
export const COORDINATION_SCORE_DELIVERY_BUDGET_MS = 2_000;
const DELIVERY_CONCURRENCY = 4;

export async function deliverCoordinationScores(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  row: CoordinationStateRow | undefined,
  options: { readonly deadlineMs?: number; readonly now?: () => number } = {},
): Promise<boolean> {
  if (!row?.pendingScores) return true;
  const now = options.now ?? Date.now;
  const deadline = options.deadlineMs ?? now() + COORDINATION_SCORE_DELIVERY_BUDGET_MS;
  if (now() >= deadline) return false;
  const { scoreDelivery = store } = store;
  const repository = await resolveDeploymentsRepository(scoreDelivery);
  const delivery = row.pendingScores;
  const sorted = Object.entries(delivery.teams).sort(([a], [b]) => a.localeCompare(b));
  const savedResume = delivery.resumeAfterTeamId;
  const resumeAt = savedResume
    ? sorted.findIndex(([teamId]) => teamId.localeCompare(savedResume) > 0)
    : 0;
  const entries = [
    ...sorted.slice(Math.max(0, resumeAt)),
    ...sorted.slice(0, Math.max(0, resumeAt)),
  ];
  const candidates = entries.length
    ? await repository.listByTenantAndEvent(scope.tenantId, scope.eventId)
    : [];
  const completed: string[] = [];
  let failure: unknown;
  let resumeAfterTeamId: string | undefined;
  for (
    let offset = 0;
    offset < entries.length && now() < deadline;
    offset += DELIVERY_CONCURRENCY
  ) {
    const batch = entries.slice(offset, offset + DELIVERY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async ([teamId, change]) => {
        const jobs = candidates.filter((candidate) => matchesTeam(candidate, scope, teamId));
        // Missing index rows are not evidence of retirement. Keep them pending.
        if (!jobs.length) throw new Error("Coordination score delivery has no deployment");
        for (const candidate of jobs) {
          if (now() >= deadline) throw new Error("Coordination score delivery budget exhausted");
          await publishJobScore(repository, candidate.jobId, {
            scope,
            teamId,
            change,
            version: row.version,
            occurredAt: delivery.occurredAt,
            initializing: delivery.initializing === true,
            scoreMode: store.coordinationScoreModes?.[scope.problemId],
          });
        }
        return teamId;
      }),
    );
    completed.push(
      ...results.filter((result) => result.status === "fulfilled").map((result) => result.value),
    );
    failure ??= results.find((result) => result.status === "rejected")?.reason;
    resumeAfterTeamId = batch.at(-1)?.[0];
  }
  // Persist the remaining team set once per slice. The next tick starts with remaining
  // work, rather than spending a small budget rereading an already delivered prefix.
  const complete = completed.length === entries.length;
  if (complete || resumeAfterTeamId !== undefined) {
    await repository.acknowledgeCoordinationScores(
      scope,
      row.version,
      complete ? undefined : completed,
      complete ? undefined : resumeAfterTeamId,
    );
  }
  if (failure !== undefined) throw failure;
  return complete;
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
    readonly initializing: boolean;
    readonly scoreMode?: "exclusive" | "additive";
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
  const previousSubtotal = previousCoordinationSubtotal(
    deployment,
    input.scoreMode,
    change.before,
    input.initializing,
  );
  const repair = change.before - previousSubtotal;
  const delta = change.score - change.before;
  const events = [
    ...(repair === 0
      ? []
      : [
          {
            ...buildScoreEventRecord(deployment, "coordination", repair, input.occurredAt),
            reason: "sync",
          },
        ]),
    ...(delta === 0
      ? []
      : [
          {
            ...buildScoreEventRecord(deployment, "coordination", delta, input.occurredAt),
            reason: change.reason,
          },
        ]),
  ];
  const result = await repository.publishCoordinationScore(scope, input.version, {
    jobId: deployment.jobId,
    teamId,
    expectedScore: current,
    expectedStatus: deployment.status,
    score: (current ?? 0) - previousSubtotal + change.score,
    coordinationSubtotal: change.score,
    occurredAt: input.occurredAt,
    events,
  });
  if (result.outcome !== "updated")
    throw new Error("Coordination score delivery conflicted; retry the saved batch");
}

/** Legacy rows have no subtotal. Evidence of any ordinary scorer takes precedence over today's catalog. */
function previousCoordinationSubtotal(
  deployment: DeploymentRecord,
  scoreMode: "exclusive" | "additive" | undefined,
  beforePluginScore: number,
  initializing: boolean,
): number {
  if (typeof deployment.coordinationSubtotal === "number") return deployment.coordinationSubtotal;
  const ordinaryScoringSeen = [
    deployment.gateBonusAwardedAt,
    deployment.hintsRevealed,
    deployment.flagSubmitted,
    deployment.solvedFlagIds,
    deployment.wrongAnswerCount,
    deployment.scoringState,
    deployment.lastResult,
    deployment.endpointsHealth,
    deployment.attackProbes,
    deployment.posture,
    deployment.platform,
  ].some((value) => value !== undefined);
  if (scoreMode !== "exclusive" || ordinaryScoringSeen) return initializing ? 0 : beforePluginScore;
  return deployment.score ?? 0;
}

/** A committed move stays committed even when delivery needs the next tick to retry it. */
export async function tryDeliverCoordinationScores(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  row: CoordinationStateRow,
  options: { readonly deadlineMs?: number } = {},
): Promise<void> {
  const complete = await deliverCoordinationScores(store, scope, row, options).catch(() => false);
  if (!complete) {
    console.warn("[coordination] score delivery pending; next tick retries", {
      tenantId: scope.tenantId,
      eventId: scope.eventId,
      problemId: scope.problemId,
      runId: scope.runId,
      version: row.version,
    });
  }
}
