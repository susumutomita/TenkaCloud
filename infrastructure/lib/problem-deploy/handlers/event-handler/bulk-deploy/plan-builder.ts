import { ulid } from "ulid";
import type { TeamRecord } from "../../../control-data/teams-repository.js";
import { buildStackPrefix, slugify } from "../../deploy-handler/naming.js";
import type { DeploymentItem } from "../../deploy-handler/types.js";
import type { VerifiedCompetitorAccount } from "../../shared/competitor-account-lookup.js";
import {
  provenanceItemFields,
  toDeploymentProvenance,
} from "../../shared/deployment-provenance.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
} from "../../shared/events.js";
import type { EventSharedResources } from "../shared.js";
import type { EventItem, EventProblemTarget } from "../types.js";
import {
  type BulkDeployPlan,
  DEFAULT_TTL_MS,
  type ExistingDeploymentIndex,
  type PlanEntry,
  type SelectedBulkDeployTargets,
  toEpochSeconds,
} from "./types.js";

export interface BuildBulkDeployPlanArgs {
  readonly shared: EventSharedResources;
  readonly tenantId: string;
  readonly eventId: string;
  readonly nowMs: number;
  readonly event: Partial<EventItem>;
  readonly selected: SelectedBulkDeployTargets;
  readonly existing: ExistingDeploymentIndex;
  readonly verified: Map<string, VerifiedCompetitorAccount>;
  readonly retryFailedOnly: boolean;
  readonly forceRedeploy: boolean;
}

/**
 * teams × problems を全 iterate し、 (replace 対象 jobId / problemsCatalog / awsAccountId /
 * verified record) を全て満たした組み合わせだけ PlanEntry を出す。 既存衝突 / problemsCatalog
 * 欠落 / awsAccountId 欠落は skipped に、 verified 欠落は unverifiedAccounts に計上する。
 */
export function buildBulkDeployPlan(args: BuildBulkDeployPlanArgs): BulkDeployPlan {
  const createdAt = new Date(args.nowMs).toISOString();
  const plan: PlanEntry[] = [];
  let skipped = 0;
  const unverifiedAccounts = new Set<string>();
  for (const team of args.selected.teams) {
    for (const problem of args.selected.problems) {
      const candidate = buildBulkPlanEntry(args, team, problem, createdAt);
      if (candidate.kind === "entry") plan.push(candidate.entry);
      if (candidate.kind === "skip") skipped++;
      if (candidate.kind === "unverified") unverifiedAccounts.add(candidate.accountId);
    }
  }
  return { entries: plan, createdAt, skipped, unverifiedAccounts };
}

type BulkPlanCandidate =
  | { readonly kind: "entry"; readonly entry: PlanEntry }
  | { readonly kind: "skip" }
  | { readonly kind: "ignore" }
  | { readonly kind: "unverified"; readonly accountId: string };

function buildBulkPlanEntry(
  args: BuildBulkDeployPlanArgs,
  team: TeamRecord,
  problem: EventProblemTarget,
  createdAt: string,
): BulkPlanCandidate {
  const key = `${team.teamId} ${problem.problemId}`;
  const replacement = selectPlanReplacement(args, key);
  if (args.retryFailedOnly && !replacement) return { kind: "ignore" };
  if (shouldSkipExistingPlanTarget(args, key, replacement)) return { kind: "skip" };
  const problemDir = args.shared.problemsCatalog[problem.problemId];
  if (!problemDir) return { kind: "skip" };
  const awsAccountId = team.awsAccountId ?? problem.defaultAwsAccountId;
  if (!awsAccountId) return { kind: "skip" };
  const verified = args.verified.get(awsAccountId);
  if (!verified) return { kind: "unverified", accountId: awsAccountId };
  return {
    kind: "entry",
    entry: createPlanEntry(
      args,
      team,
      problem,
      problemDir,
      awsAccountId,
      verified,
      replacement,
      createdAt,
    ),
  };
}

function selectPlanReplacement(
  args: BuildBulkDeployPlanArgs,
  key: string,
): { jobId: string } | undefined {
  if (args.retryFailedOnly) return args.existing.failedByKey.get(key);
  return args.forceRedeploy ? args.existing.forceRedeployByKey.get(key) : undefined;
}

function shouldSkipExistingPlanTarget(
  args: BuildBulkDeployPlanArgs,
  key: string,
  replacement: { jobId: string } | undefined,
): boolean {
  if (args.retryFailedOnly || !args.existing.existingKey.has(key)) return false;
  return !(args.forceRedeploy && replacement);
}

function createPlanEntry(
  args: BuildBulkDeployPlanArgs,
  team: TeamRecord,
  problem: EventProblemTarget,
  problemDir: string,
  awsAccountId: string,
  verified: VerifiedCompetitorAccount,
  replacement: { jobId: string } | undefined,
  createdAt: string,
): PlanEntry {
  const jobId = ulid();
  const namePrefix = buildStackPrefix(problem.problemId, team.internalSlug);
  const item = createDeploymentItem(
    args,
    team,
    problem,
    awsAccountId,
    verified,
    jobId,
    namePrefix,
    createdAt,
  );
  const detail = createDeployDetail(
    args.tenantId,
    team,
    problem,
    problemDir,
    awsAccountId,
    verified,
    jobId,
    namePrefix,
  );
  return {
    item,
    entry: {
      EventBusName: args.shared.eventBusName,
      Source: EVENT_SOURCE,
      DetailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
      Detail: JSON.stringify(detail),
      Resources: [`tenkacloud:deployment:${jobId}`],
    },
    replacesJobId: replacement?.jobId,
  };
}

function createDeploymentItem(
  args: BuildBulkDeployPlanArgs,
  team: TeamRecord,
  problem: EventProblemTarget,
  awsAccountId: string,
  verified: VerifiedCompetitorAccount,
  jobId: string,
  namePrefix: string,
  createdAt: string,
): DeploymentItem {
  // TeamRecord は teamLoginKey を型上 optional にする (SQL backend が plaintext bearer を
  // index 列に載せないため) が、 DDB backend の list は非キー属性として実値を保持する
  // (create.ts が必ず非空 key を書き込む)。 従来の非空値を保つための coercion (実データでは常に非空)。
  const teamLoginKey = team.teamLoginKey ?? "";
  return {
    PK: `DEPLOYMENT#${jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${args.tenantId}`,
    GSI1SK: createdAt,
    GSI2PK: `TEAMKEY#${teamLoginKey}`,
    GSI2SK: createdAt,
    jobId,
    problemId: problem.problemId,
    tenantId: args.tenantId,
    awsAccountId,
    competitorRoleArn: verified.competitorRoleArn,
    region: problem.defaultRegion,
    teamName: team.internalSlug,
    namePrefix,
    teamLoginKey,
    status: "PENDING",
    createdAt,
    updatedAt: createdAt,
    expiresAt: toEpochSeconds(args.nowMs + DEFAULT_TTL_MS),
    eventId: args.eventId,
    teamId: team.teamId,
    eventStartsAt: typeof args.event.startsAt === "string" ? args.event.startsAt : undefined,
    eventEndsAt: typeof args.event.endsAt === "string" ? args.event.endsAt : undefined,
    // [#2096] Pack-sourced deployments only: copy immutable provenance from the
    // event-pinned snapshot (#2095). Core problems / no resolver → no attribute,
    // keeping the row byte-identical.
    ...provenanceItemFields(resolvePlanProvenance(args, problem.problemId)),
  };
}

/**
 * [#2096] Resolve a problem's display/audit-safe provenance from the event-pinned
 * snapshot via the injected resolver. Returns undefined for a core problem, when
 * the problem is not pinned, or when no resolver is wired.
 */
function resolvePlanProvenance(args: BuildBulkDeployPlanArgs, problemId: string) {
  const resolved = args.shared.resolveDeploymentProvenance?.(args.eventId, problemId);
  if (!resolved) return undefined;
  return toDeploymentProvenance(resolved.provenance, resolved.catalogSnapshotId);
}

function createDeployDetail(
  tenantId: string,
  team: TeamRecord,
  problem: EventProblemTarget,
  problemDir: string,
  awsAccountId: string,
  verified: VerifiedCompetitorAccount,
  jobId: string,
  namePrefix: string,
): DeployCreateRequestedDetail {
  return {
    jobId,
    correlationId: jobId,
    tenantId,
    problemId: problem.problemId,
    problemDir,
    teamSlug: slugify(team.internalSlug),
    namePrefix,
    region: problem.defaultRegion,
    awsAccountId,
    competitorRoleArn: verified.competitorRoleArn,
    externalIdParameterName: verified.externalIdParameterName,
  };
}
