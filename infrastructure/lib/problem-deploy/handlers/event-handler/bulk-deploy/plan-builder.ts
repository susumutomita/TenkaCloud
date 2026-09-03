import { ulid } from "ulid";
import type { TeamDeploymentRecord } from "../../../control-data/teams-repository.js";
import { buildStackPrefix, slugify } from "../../deploy-handler/naming.js";
import { type DeploymentItem, runtimeItemFields } from "../../deploy-handler/types.js";
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
import {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isReservedRuntime,
  type ProblemRuntime,
  type ProblemRuntimeDescriptor,
} from "../../shared/runtime/index.js";
import type { EventSharedResources } from "../shared.js";
import type { EventItem, EventProblemTarget } from "../types.js";
import {
  type BulkDeployPlan,
  DEFAULT_TTL_MS,
  type ExistingDeploymentIndex,
  nonAwsCredentialKey,
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
  /** [#2571] non-AWS single-provider の credential 登録有無。`resolveBulkNonAwsCredentials` の戻り値。 */
  readonly nonAwsCredentials: ReadonlySet<string>;
  readonly retryFailedOnly: boolean;
  readonly forceRedeploy: boolean;
}

/**
 * teams × problems を全 iterate し、 (replace 対象 jobId / problemsCatalog / awsAccountId /
 * verified record) を全て満たした組み合わせだけ PlanEntry を出す。 既存衝突 / problemsCatalog
 * 欠落 / awsAccountId 欠落は skipped に、 verified 欠落は unverifiedAccounts に、 credential 未登録の
 * 非 AWS single-provider 組は missingCredentials に、 ssm 未配線の非 AWS single-provider 問題は
 * unsupportedRuntimeProblems に計上する (#2571: 下の buildBulkPlanEntry コメント参照)。
 */
export function buildBulkDeployPlan(args: BuildBulkDeployPlanArgs): BulkDeployPlan {
  const createdAt = new Date(args.nowMs).toISOString();
  const acc = createBulkPlanAccumulator();
  for (const team of args.selected.teams) {
    for (const problem of args.selected.problems) {
      recordBulkPlanCandidate(acc, buildBulkPlanEntry(args, team, problem, createdAt));
    }
  }
  return {
    entries: acc.plan,
    createdAt,
    skipped: acc.skipped,
    unverifiedAccounts: acc.unverifiedAccounts,
    unsupportedRuntimeProblems: acc.unsupportedRuntimeProblems,
    missingCredentials: acc.missingCredentials,
  };
}

type BulkPlanCandidate =
  | { readonly kind: "entry"; readonly entry: PlanEntry }
  | { readonly kind: "skip" }
  | { readonly kind: "ignore" }
  | { readonly kind: "unverified"; readonly accountId: string }
  | { readonly kind: "unsupportedRuntime"; readonly problemId: string }
  | { readonly kind: "missingCredential"; readonly provider: string; readonly teamSlug: string };

interface BulkPlanAccumulator {
  readonly plan: PlanEntry[];
  skipped: number;
  readonly unverifiedAccounts: Set<string>;
  readonly unsupportedRuntimeProblems: Set<string>;
  readonly missingCredentials: Set<string>;
}

function createBulkPlanAccumulator(): BulkPlanAccumulator {
  return {
    plan: [],
    skipped: 0,
    unverifiedAccounts: new Set(),
    unsupportedRuntimeProblems: new Set(),
    missingCredentials: new Set(),
  };
}

/**
 * [#2571] Extracted out of {@link buildBulkDeployPlan}'s inner loop to keep the
 * per-candidate branching (5 kinds, up from the pre-#2571 4) from pushing that
 * loop over the cognitive-complexity budget.
 */
function recordBulkPlanCandidate(acc: BulkPlanAccumulator, candidate: BulkPlanCandidate): void {
  switch (candidate.kind) {
    case "entry":
      acc.plan.push(candidate.entry);
      return;
    case "skip":
      acc.skipped++;
      return;
    case "unverified":
      acc.unverifiedAccounts.add(candidate.accountId);
      return;
    case "unsupportedRuntime":
      acc.unsupportedRuntimeProblems.add(candidate.problemId);
      return;
    case "missingCredential":
      acc.missingCredentials.add(`${candidate.provider}:${candidate.teamSlug}`);
      return;
    case "ignore":
      return;
  }
}

function buildBulkPlanEntry(
  args: BuildBulkDeployPlanArgs,
  team: TeamDeploymentRecord,
  problem: EventProblemTarget,
  createdAt: string,
): BulkPlanCandidate {
  const key = `${team.teamId} ${problem.problemId}`;
  const replacement = selectPlanReplacement(args, key);
  if (args.retryFailedOnly && !replacement) return { kind: "ignore" };
  if (shouldSkipExistingPlanTarget(args, key, replacement)) return { kind: "skip" };
  const problemDir = args.shared.problemsCatalog[problem.problemId];
  if (!problemDir) return { kind: "skip" };
  const runtime = args.shared.resolveProblemRuntimeDescriptor?.(problem.problemId);
  const dispatch = classifyBulkRuntimeDispatch(runtime);
  if (dispatch.channel === "adapter") {
    return buildNonAwsPlanCandidate(
      args,
      team,
      problem,
      problemDir,
      dispatch.runtime,
      replacement,
      createdAt,
    );
  }
  if (dispatch.channel === "unsupported") {
    return { kind: "unsupportedRuntime", problemId: problem.problemId };
  }
  const awsAccountId = team.awsAccountId ?? problem.defaultAwsAccountId;
  if (!awsAccountId) return { kind: "skip" };
  const verified = args.verified.get(awsAccountId);
  if (!verified) return { kind: "unverified", accountId: awsAccountId };
  return {
    kind: "entry",
    entry: createAwsPlanEntry(
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

type BulkRuntimeDispatch =
  | { readonly channel: "aws" }
  | { readonly channel: "adapter"; readonly runtime: ProblemRuntime }
  | { readonly channel: "unsupported" };

/**
 * [#2571 review-fix] Engine-aware dispatch gate (single-deploy parity).
 *
 * The pre-fix gate matched `NON_AWS_CLOUD_PROVIDERS.includes(runtime.provider)`
 * — provider only, ignoring `engine` — so a `{provider:"gcp", engine:"terraform"}`
 * descriptor (a provider match but not a registered engine) took the adapter
 * path and threw a per-row `RuntimeNotSupportedError` deep inside
 * `dispatchBulkAdapterEntries` instead of being refused up front, while a
 * `{provider:"docker", engine:"compose"}` local-play descriptor fell through to the AWS/CFn
 * path even though it is not a non-AWS cloud runtime, and
 * violated its frozen-schema precondition (single-deploy rejects the same
 * runtime pre-mutation).
 *
 * `isReservedRuntime` checks the exact `(provider, engine)` pair against
 * `@tenkacloud/problem-runtime`'s `RESERVED_RUNTIMES` — the same predicate
 * `verified-accounts.ts`'s `candidateNonAwsProviders` uses (#2562), so the two
 * call sites cannot drift apart.
 *
 * A composite descriptor (`"kind" in runtime`) or an absent resolver result
 * (`runtime === undefined`) keeps the pre-#2571 AWS-path behavior
 * byte-identically — this gate only narrows what a *resolved single*
 * descriptor does.
 */
function classifyBulkRuntimeDispatch(
  runtime: ProblemRuntimeDescriptor | undefined,
): BulkRuntimeDispatch {
  if (runtime === undefined || "kind" in runtime) return { channel: "aws" };
  if (runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE) {
    return { channel: "aws" };
  }
  if (isReservedRuntime(runtime)) return { channel: "adapter", runtime };
  return { channel: "unsupported" };
}

/**
 * [#2571] Bulk deploy rides the frozen DeployCreateRequested -> CFn state
 * machine, which is AWS-only. A non-AWS single-provider problem (gcp/azure/
 * sakura) instead dispatches through the same adapter seam the single-deploy
 * path uses (`selectAdapter` + `dispatchPreparedDeployment`, wired up in
 * `adapter-dispatch.ts`). `!shared.ssm` preserves the v1 (#2563) loud refusal
 * for any Lambda that has not been wired with the per-team credential SSM
 * grants (today: the scheduled reconciler path, staged enablement). A missing
 * per-team credential registration is reported as its own `missingCredential`
 * candidate — distinct from `unsupportedRuntime` — so the operator learns
 * exactly which (provider, team) pair needs registering, rather than being
 * told the whole bulk path is unsupported.
 */
function buildNonAwsPlanCandidate(
  args: BuildBulkDeployPlanArgs,
  team: TeamDeploymentRecord,
  problem: EventProblemTarget,
  problemDir: string,
  runtime: ProblemRuntime,
  replacement: { jobId: string } | undefined,
  createdAt: string,
): BulkPlanCandidate {
  if (!args.shared.ssm) {
    return { kind: "unsupportedRuntime", problemId: problem.problemId };
  }
  const teamSlug = slugify(team.internalSlug);
  if (!args.nonAwsCredentials.has(nonAwsCredentialKey(runtime.provider, teamSlug))) {
    return { kind: "missingCredential", provider: runtime.provider, teamSlug };
  }
  return {
    kind: "entry",
    entry: createNonAwsPlanEntry(
      args,
      team,
      problem,
      problemDir,
      runtime,
      teamSlug,
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

function createAwsPlanEntry(
  args: BuildBulkDeployPlanArgs,
  team: TeamDeploymentRecord,
  problem: EventProblemTarget,
  problemDir: string,
  awsAccountId: string,
  verified: VerifiedCompetitorAccount,
  replacement: { jobId: string } | undefined,
  createdAt: string,
): PlanEntry {
  const jobId = ulid();
  const namePrefix = buildStackPrefix(problem.problemId, team.internalSlug);
  const item = createDeploymentItem(args, team, problem, jobId, namePrefix, createdAt, {
    awsAccountId,
    region: team.region ?? problem.defaultRegion,
    competitorRoleArn: verified.competitorRoleArn,
  });
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
    kind: "eventbridge",
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

/**
 * [#2571] The non-AWS single-provider counterpart of {@link createAwsPlanEntry}.
 * The row mirrors the single-deploy convention (`deploy.ts` / #2561):
 * `awsAccountId: ""`, `region: ""`, no `competitorRoleArn`, plus the runtime's
 * provider/engine/entry so `runtime-status-reconciler.ts` and `bulk-delete.ts`
 * can route the row through its adapter instead of CFn. No
 * `PutEventsRequestEntry` — the row never rides the frozen CFn pipeline;
 * `dispatchBulkAdapterEntries` (`adapter-dispatch.ts`) dispatches it directly.
 */
function createNonAwsPlanEntry(
  args: BuildBulkDeployPlanArgs,
  team: TeamDeploymentRecord,
  problem: EventProblemTarget,
  problemDir: string,
  runtime: ProblemRuntime,
  teamSlug: string,
  replacement: { jobId: string } | undefined,
  createdAt: string,
): PlanEntry {
  const jobId = ulid();
  const namePrefix = buildStackPrefix(problem.problemId, team.internalSlug);
  // [#2571 review-fix] `runtimeItemFields` is the same function `deploy.ts` (the
  // single-deploy path) uses to decide the runtime fields for a DeploymentItem —
  // reusing it here instead of an inline `{runtimeProvider, runtimeEngine,
  // runtimeEntry}` literal means the two paths can't drift on which fields get
  // set or under what condition they're omitted.
  const item = createDeploymentItem(
    args,
    team,
    problem,
    jobId,
    namePrefix,
    createdAt,
    { awsAccountId: "", region: "" },
    runtimeItemFields(runtime),
  );
  return {
    kind: "adapter",
    item,
    runtime,
    problemDir,
    teamSlug,
    replacesJobId: replacement?.jobId,
  };
}

/**
 * Shared row builder for both the AWS/CFn and non-AWS/adapter branches.
 * `aws.competitorRoleArn` is always present (a real ARN string) for an AWS row
 * — preserving the pre-#2571 byte-identical field order — and omitted
 * entirely (not even `undefined`) for a non-AWS row, mirroring the
 * single-deploy convention (`deploy.ts`'s `item` construction, #2561).
 * `runtimeFields` defaults to `{}` so an AWS row's shape is unaffected.
 */
function createDeploymentItem(
  args: BuildBulkDeployPlanArgs,
  team: TeamDeploymentRecord,
  problem: EventProblemTarget,
  jobId: string,
  namePrefix: string,
  createdAt: string,
  aws: {
    readonly awsAccountId: string;
    readonly region: string;
    readonly competitorRoleArn?: string;
  },
  runtimeFields: Partial<
    Pick<DeploymentItem, "runtimeProvider" | "runtimeEngine" | "runtimeEntry">
  > = {},
): DeploymentItem {
  const participantCredential =
    team.credential.kind === "plaintext"
      ? {
          teamLoginKey: team.credential.value,
          GSI2PK: `TEAMKEY#${team.credential.value}`,
          GSI2SK: createdAt,
        }
      : { teamLoginKeyHash: team.credential.value };
  return {
    PK: `DEPLOYMENT#${jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${args.tenantId}`,
    GSI1SK: createdAt,
    jobId,
    problemId: problem.problemId,
    tenantId: args.tenantId,
    awsAccountId: aws.awsAccountId,
    ...(aws.competitorRoleArn ? { competitorRoleArn: aws.competitorRoleArn } : {}),
    region: aws.region,
    teamName: team.internalSlug,
    namePrefix,
    ...participantCredential,
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
    // [#2571] Non-AWS runtime rows only (empty object for AWS — byte-identical
    // to the pre-#2571 shape). Mirrors `deploy.ts`'s `runtimeItemFields`.
    ...runtimeFields,
  };
}

/**
 * [#2096] Resolve a problem's display/audit-safe provenance from the event-pinned
 * snapshot. The injected resolver remains for CLI/tests; otherwise the runtime
 * path reads the pin embedded on the Event record. Returns undefined for a core
 * problem, when the problem is not pinned, or when the event predates #2464.
 */
function resolvePlanProvenance(args: BuildBulkDeployPlanArgs, problemId: string) {
  const resolved = args.shared.resolveDeploymentProvenance?.(args.eventId, problemId);
  if (resolved) return toDeploymentProvenance(resolved.provenance, resolved.catalogSnapshotId);
  const catalogSnapshotId = args.event.catalogSnapshotId;
  const packProvenance = args.event.packProvenance?.[problemId];
  if (!catalogSnapshotId || !packProvenance) return undefined;
  return toDeploymentProvenance({ source: "pack", ...packProvenance }, catalogSnapshotId);
}

function createDeployDetail(
  tenantId: string,
  team: TeamDeploymentRecord,
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
    region: team.region ?? problem.defaultRegion,
    awsAccountId,
    competitorRoleArn: verified.competitorRoleArn,
    externalIdParameterName: verified.externalIdParameterName,
  };
}
