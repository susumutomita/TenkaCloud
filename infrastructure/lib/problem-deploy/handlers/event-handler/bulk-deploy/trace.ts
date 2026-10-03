import type { DeploymentItem } from "../../deploy-handler/types.js";
import { logDeployTrace, warnDeployTrace } from "../../shared/trace-log.js";
import type { BulkDeployRequest } from "../types.js";
import type {
  BulkDeployPlan,
  ExistingDeploymentIndex,
  LoadedBulkDeployTargets,
  SelectedBulkDeployTargets,
} from "./types.js";

/**
 * 「teams が 0 件 or problems が 0 件で即時 return する」分岐の warn trace。
 * operator が dry-run 時に「なぜ 0 件か」を CloudWatch Logs で追えるよう情報を残す。
 */
export function traceEmptyBulkDeploy(
  eventId: string,
  tenantId: string,
  loaded: LoadedBulkDeployTargets,
  request: BulkDeployRequest | undefined,
): void {
  warnDeployTrace("bulk-deploy.skip.no_teams_or_problems", {
    correlationId: eventId,
    tenantId,
    allTeamsCount: loaded.allTeams.length,
    allProblemsCount: loaded.allProblems.length,
    retryFailedOnly: request?.retryFailedOnly === true,
  });
}

/**
 * `retryFailedOnly` で FAILED 行が 1 件もなく即 return するケースの warn trace。
 * existing deployment の status breakdown を残し、 retry 候補がなかった理由を可視化する。
 */
export function traceNoFailedRows(
  eventId: string,
  tenantId: string,
  existing: readonly Partial<DeploymentItem>[],
): void {
  warnDeployTrace("bulk-deploy.skip.no_failed_rows", {
    correlationId: eventId,
    tenantId,
    retryFailedOnly: true,
    existingDeploymentsCount: existing.length,
    statusBreakdown: Object.fromEntries(
      existing.reduce((acc, deployment) => {
        const status = String(deployment.status ?? "<unset>");
        acc.set(status, (acc.get(status) ?? 0) + 1);
        return acc;
      }, new Map<string, number>()),
    ),
  });
}

/**
 * plan iterate 後に entries が 0 件になったケース (= 全 skip / 全 ignore) の warn trace。
 * failed key / live ids も残し、 plan が空になった理由を operator が後追いできるようにする。
 */
export function traceEmptyPlan(
  eventId: string,
  tenantId: string,
  selected: SelectedBulkDeployTargets,
  existing: ExistingDeploymentIndex,
  plan: BulkDeployPlan,
  retryFailedOnly: boolean,
  forceRedeploy: boolean,
): void {
  warnDeployTrace("bulk-deploy.skip.plan_empty_after_iteration", {
    correlationId: eventId,
    tenantId,
    retryFailedOnly,
    forceRedeploy,
    teamsCount: selected.teams.length,
    problemsCount: selected.problems.length,
    failedByKeyCount: existing.failedByKey.size,
    forceRedeployByKeyCount: existing.forceRedeployByKey.size,
    existingKeyCount: existing.existingKey.size,
    skipped: plan.skipped,
    unverifiedAccountsCount: plan.unverifiedAccounts.size,
    // [#2571 review-fix] Without this, an all-non-AWS event where no team has a
    // registered credential produces an empty plan logged with
    // unverifiedAccountsCount:0 / skipped:0 — indistinguishable in CloudWatch
    // from "nothing to do". Surfacing the count AND the sorted (provider, team)
    // list (same shape `BulkDeployResult.missingCredentials` already returns to
    // the operator, see `result.ts`) makes this diagnosable from the trace
    // alone, without needing the HTTP response.
    missingCredentialsCount: plan.missingCredentials.size,
    missingCredentials: Array.from(plan.missingCredentials).sort(),
    failedKeys: Array.from(existing.failedByKey.keys()),
    liveTeamIds: selected.teams.map((team) => team.teamId),
    liveProblemIds: selected.problems.map((problem) => problem.problemId),
  });
}

/** 実 publish 直前の info trace。 enqueued 件数 / skipped / unverified を残す。 */
export function traceBulkPlan(
  eventId: string,
  tenantId: string,
  plan: BulkDeployPlan,
  retryFailedOnly: boolean,
  forceRedeploy: boolean,
): void {
  logDeployTrace("bulk-deploy.enqueued", {
    correlationId: eventId,
    tenantId,
    retryFailedOnly,
    forceRedeploy,
    planCount: plan.entries.length,
    skipped: plan.skipped,
    unverifiedAccountsCount: plan.unverifiedAccounts.size,
    // [#2571 review-fix] See `traceEmptyPlan`'s comment — same
    // missing-credential observability gap, mirrored here for the non-empty
    // (some rows enqueued, some withheld) case.
    missingCredentialsCount: plan.missingCredentials.size,
    missingCredentials: Array.from(plan.missingCredentials).sort(),
  });
}
