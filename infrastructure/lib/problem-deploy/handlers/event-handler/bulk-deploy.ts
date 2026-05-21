import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { buildStackPrefix, slugify } from "../deploy-handler/naming.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  resolveVerifiedCompetitorAccount,
  type VerifiedCompetitorAccount,
} from "../shared/competitor-account-lookup.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_BULK_DEPLOY_CREATE_REQUESTED,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";
import { logDeployTrace, warnDeployTrace } from "../shared/trace-log.js";
import { type EventSharedResources, queryDeploymentsByEvent } from "./shared.js";
import type { BulkDeployRequest, EventItem, EventProblemTarget, TeamItem } from "./types.js";

/**
 * `POST /events/{eventId}/deploy` のレスポンス。N×M (teams × problems) の deployment
 * 行を作成し、既存の DeployCreateRequested 経路に fan-out した結果を返す。
 */
export interface BulkDeployResult {
  readonly eventId: string;
  readonly enqueued: number;
  /** 既存 deployment 行と問題 ID 衝突で skip された組み合わせ数 (再 deploy 防止)。 */
  readonly skipped: number;
  /**
   * Phase 2.2 (Issue #459): verified=false / 未登録の awsAccountId のため reject された
   * team 数。`unverifiedAccounts` には実 awsAccountId を入れて operator が補正できるよう
   * 通知する。
   */
  readonly unverified?: number;
  /** Phase 2.2: 上記の補足情報。重複は除く (Set 化)。 */
  readonly unverifiedAccounts?: readonly string[];
}

export type BulkDeployOutcome = { kind: "ok"; result: BulkDeployResult } | { kind: "not_found" };

const TRANSACT_WRITE_BATCH = 25;
const PUT_EVENTS_BATCH = 10;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

interface PlanEntry {
  readonly item: DeploymentItem;
  readonly entry: PutEventsRequestEntry;
  /** retry / force redeploy のとき、対応する旧行の jobId (= これを DELETE)。 */
  readonly replacesJobId?: string;
}

/**
 * `bulkDeployEvent` は Event / Teams を読み、選択された problems 全てに対して
 * teams × problems の deployment 行を一括 PUT し、既存 `DeployCreateRequested` を
 * 個別に publish する (= EventBridge fan-out)。
 *
 * 各 deployment 行は eventId / teamId / teamLoginKey (Team 行と同値) を持ち、
 * Phase 2c の Participant Portal は teamLoginKey で `team の全 deployment` を引ける。
 *
 * 既存 deployment と (eventId, teamId, problemId) が衝突する場合は in-memory で
 * 検出して skipped に計上する (= 後追い deploy で既行を二重生成しない)。
 *
 * `tenantId` mismatch / event 不在は `not_found`。teams / problems 両方 0 件はそのまま
 * `enqueued: 0` を返す (= operator の即時 dry-run 用途)。
 *
 * `request` (#555):
 *   - `undefined` / `{}` → 従来通り全展開 (= 既存衝突分のみ skip)
 *   - `{ retryFailedOnly: true }` → FAILED 状態の旧行を DELETE → 同 (teamId, problemId) で
 *     新 jobId の PENDING を CREATE。旧 jobId は失われる (= 履歴より状態のクリーンさを優先、
 *     failureReason の monitoring は publish 直後の CloudWatch Logs に残る)。
 *   - `{ forceRedeploy: true }` → COMPLETE / FAILED / DELETED の旧行を DELETE → 同
 *     (teamId, problemId) で新 jobId の PENDING を CREATE。PENDING / IN_PROGRESS / DELETING
 *     は二重実行防止のため skip。
 *   - `{ teamIds }` / `{ problemIds }` → 範囲を絞る (後追い team / 問題用)
 *   - 組み合わせ可能 (= `{ retryFailedOnly: true, teamIds: [t1] }` で「team t1 の失敗のみ retry」)
 */
export async function bulkDeployEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
  request?: BulkDeployRequest,
): Promise<BulkDeployOutcome> {
  const loaded = await loadBulkDeployTargets(shared, tenantId, eventId);
  if (!loaded) return { kind: "not_found" };
  if (loaded.allTeams.length === 0 || loaded.allProblems.length === 0) {
    traceEmptyBulkDeploy(eventId, tenantId, loaded, request);
    return emptyBulkDeployResult(eventId);
  }
  const selected = selectBulkDeployTargets(eventId, tenantId, loaded, request);
  if (!selected) return emptyBulkDeployResult(eventId);
  const existingDeployments = await queryDeploymentsByEvent(
    shared,
    tenantId,
    eventId,
    "jobId, teamId, problemId, #s",
  );
  const existing = indexExistingDeployments(existingDeployments);
  const retryFailedOnly = request?.retryFailedOnly === true;
  const forceRedeploy = request?.forceRedeploy === true;
  if (retryFailedOnly && existing.failedByKey.size === 0) {
    traceNoFailedRows(eventId, tenantId, existingDeployments);
    return emptyBulkDeployResult(eventId);
  }
  const verified = await resolveBulkVerifiedAccounts(
    shared,
    tenantId,
    selected.teams,
    selected.problems,
  );
  const plan = buildBulkDeployPlan({
    shared,
    tenantId,
    eventId,
    nowMs,
    event: loaded.event,
    selected,
    existing,
    verified,
    retryFailedOnly,
    forceRedeploy,
  });
  if (plan.entries.length === 0) {
    traceEmptyPlan(eventId, tenantId, selected, existing, plan, retryFailedOnly, forceRedeploy);
    return { kind: "ok", result: buildResult({ eventId, enqueued: 0, ...plan }) };
  }
  traceBulkPlan(eventId, tenantId, plan, retryFailedOnly, forceRedeploy);
  await writeBulkDeployPlan(shared, tenantId, plan.entries, retryFailedOnly || forceRedeploy);
  const failures = await publishBulkDeployPlan(
    shared,
    tenantId,
    eventId,
    plan.createdAt,
    plan.entries,
  );
  if (failures.length > 0) {
    await markPublishFailuresFailed(shared, tenantId, failures, plan.createdAt);
    throw new Error(
      `EventBridge PutEvents failed for ${failures.length} deployment(s): ${failures
        .map((f) => `${f.jobId} ${f.reason}`)
        .join("; ")}`,
    );
  }

  return {
    kind: "ok",
    result: buildResult({ eventId, enqueued: plan.entries.length, ...plan }),
  };
}

interface LoadedBulkDeployTargets {
  readonly event: Partial<EventItem>;
  readonly allTeams: readonly TeamItem[];
  readonly allProblems: readonly EventProblemTarget[];
}

interface SelectedBulkDeployTargets {
  readonly teams: readonly TeamItem[];
  readonly problems: readonly EventProblemTarget[];
}

interface ExistingDeploymentIndex {
  readonly failedByKey: Map<string, { jobId: string }>;
  readonly forceRedeployByKey: Map<string, { jobId: string }>;
  readonly existingKey: Set<string>;
}

interface BulkDeployPlan {
  readonly entries: readonly PlanEntry[];
  readonly createdAt: string;
  readonly skipped: number;
  readonly unverifiedAccounts: Set<string>;
}

async function loadBulkDeployTargets(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
): Promise<LoadedBulkDeployTargets | undefined> {
  const [eventOut, teamsOut] = await Promise.all([
    shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
      }),
    ),
    shared.ddb.send(
      new QueryCommand({
        TableName: shared.teamsTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":tprefix": "TEAM#" },
      }),
    ),
  ]);
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return undefined;
  return {
    event,
    allTeams: (teamsOut.Items ?? []) as TeamItem[],
    allProblems: (Array.isArray(event.problems) ? event.problems : []) as EventProblemTarget[],
  };
}

function emptyBulkDeployResult(eventId: string): BulkDeployOutcome {
  return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
}

function traceEmptyBulkDeploy(
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

function selectBulkDeployTargets(
  eventId: string,
  tenantId: string,
  loaded: LoadedBulkDeployTargets,
  request: BulkDeployRequest | undefined,
): SelectedBulkDeployTargets | undefined {
  const teamIdFilter = request?.teamIds ? new Set(request.teamIds) : undefined;
  const problemIdFilter = request?.problemIds ? new Set(request.problemIds) : undefined;
  const teams = teamIdFilter
    ? loaded.allTeams.filter((team) => teamIdFilter.has(team.teamId))
    : loaded.allTeams;
  const problems = problemIdFilter
    ? loaded.allProblems.filter((problem) => problemIdFilter.has(problem.problemId))
    : loaded.allProblems;
  if (teams.length > 0 && problems.length > 0) return { teams, problems };
  warnDeployTrace("bulk-deploy.skip.filter_eliminated_all", {
    correlationId: eventId,
    tenantId,
    allTeamsCount: loaded.allTeams.length,
    filteredTeamsCount: teams.length,
    allProblemsCount: loaded.allProblems.length,
    filteredProblemsCount: problems.length,
    hasTeamIdFilter: teamIdFilter !== undefined,
    hasProblemIdFilter: problemIdFilter !== undefined,
  });
  return undefined;
}

function indexExistingDeployments(
  existing: readonly Partial<DeploymentItem>[],
): ExistingDeploymentIndex {
  const index: ExistingDeploymentIndex = {
    failedByKey: new Map(),
    forceRedeployByKey: new Map(),
    existingKey: new Set(),
  };
  for (const deployment of existing) addExistingDeployment(index, deployment);
  return index;
}

function addExistingDeployment(
  index: ExistingDeploymentIndex,
  deployment: Partial<DeploymentItem>,
): void {
  const teamId = String(deployment.teamId ?? "");
  const problemId = String(deployment.problemId ?? "");
  if (!teamId || !problemId) return;
  const key = `${teamId} ${problemId}`;
  index.existingKey.add(key);
  if (deployment.status === "FAILED" && !index.failedByKey.has(key)) {
    index.failedByKey.set(key, { jobId: String(deployment.jobId ?? "") });
  }
  if (isForceRedeployStatus(deployment.status) && !index.forceRedeployByKey.has(key)) {
    index.forceRedeployByKey.set(key, { jobId: String(deployment.jobId ?? "") });
  }
}

function isForceRedeployStatus(status: unknown): boolean {
  return status === "COMPLETE" || status === "FAILED" || status === "DELETED";
}

function traceNoFailedRows(
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

async function resolveBulkVerifiedAccounts(
  shared: EventSharedResources,
  tenantId: string,
  teams: readonly TeamItem[],
  problems: readonly EventProblemTarget[],
): Promise<Map<string, VerifiedCompetitorAccount>> {
  const accountIds = candidateBulkAccountIds(teams, problems);
  const verified = new Map<string, VerifiedCompetitorAccount>();
  await Promise.all(
    Array.from(accountIds).map(async (accountId) => {
      const account = await resolveVerifiedCompetitorAccount(
        {
          ddb: shared.ddb,
          competitorAccountsTableName: shared.competitorAccountsTableName,
          env: shared.env,
        },
        tenantId,
        accountId,
      );
      if (account) verified.set(accountId, account);
    }),
  );
  return verified;
}

function candidateBulkAccountIds(
  teams: readonly TeamItem[],
  problems: readonly EventProblemTarget[],
): Set<string> {
  const ids = new Set<string>();
  for (const team of teams) if (team.awsAccountId) ids.add(team.awsAccountId);
  for (const problem of problems)
    if (problem.defaultAwsAccountId) ids.add(problem.defaultAwsAccountId);
  return ids;
}

function buildBulkDeployPlan(args: {
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
}): BulkDeployPlan {
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
  args: Parameters<typeof buildBulkDeployPlan>[0],
  team: TeamItem,
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
  args: Parameters<typeof buildBulkDeployPlan>[0],
  key: string,
): { jobId: string } | undefined {
  if (args.retryFailedOnly) return args.existing.failedByKey.get(key);
  return args.forceRedeploy ? args.existing.forceRedeployByKey.get(key) : undefined;
}

function shouldSkipExistingPlanTarget(
  args: Parameters<typeof buildBulkDeployPlan>[0],
  key: string,
  replacement: { jobId: string } | undefined,
): boolean {
  if (args.retryFailedOnly || !args.existing.existingKey.has(key)) return false;
  return !(args.forceRedeploy && replacement);
}

function createPlanEntry(
  args: Parameters<typeof buildBulkDeployPlan>[0],
  team: TeamItem,
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
  args: Parameters<typeof buildBulkDeployPlan>[0],
  team: TeamItem,
  problem: EventProblemTarget,
  awsAccountId: string,
  verified: VerifiedCompetitorAccount,
  jobId: string,
  namePrefix: string,
  createdAt: string,
): DeploymentItem {
  return {
    PK: `DEPLOYMENT#${jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${args.tenantId}`,
    GSI1SK: createdAt,
    GSI2PK: `TEAMKEY#${team.teamLoginKey}`,
    GSI2SK: createdAt,
    jobId,
    problemId: problem.problemId,
    tenantId: args.tenantId,
    awsAccountId,
    competitorRoleArn: verified.competitorRoleArn,
    region: problem.defaultRegion,
    teamName: team.internalSlug,
    namePrefix,
    teamLoginKey: team.teamLoginKey,
    status: "PENDING",
    createdAt,
    updatedAt: createdAt,
    expiresAt: toEpochSeconds(args.nowMs + DEFAULT_TTL_MS),
    eventId: args.eventId,
    teamId: team.teamId,
    eventStartsAt: typeof args.event.startsAt === "string" ? args.event.startsAt : undefined,
    eventEndsAt: typeof args.event.endsAt === "string" ? args.event.endsAt : undefined,
  };
}

function createDeployDetail(
  tenantId: string,
  team: TeamItem,
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

function traceEmptyPlan(
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
    failedKeys: Array.from(existing.failedByKey.keys()),
    liveTeamIds: selected.teams.map((team) => team.teamId),
    liveProblemIds: selected.problems.map((problem) => problem.problemId),
  });
}

function traceBulkPlan(
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
  });
}

async function writeBulkDeployPlan(
  shared: EventSharedResources,
  tenantId: string,
  plan: readonly PlanEntry[],
  replacesExisting: boolean,
): Promise<void> {
  const opsPerEntry = replacesExisting ? 2 : 1;
  const planPerChunk = Math.floor(TRANSACT_WRITE_BATCH / opsPerEntry);
  const writes: Promise<unknown>[] = [];
  for (let index = 0; index < plan.length; index += planPerChunk) {
    const transactItems = buildTransactItems(
      shared,
      tenantId,
      plan.slice(index, index + planPerChunk),
    );
    writes.push(shared.ddb.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }
  await Promise.all(writes);
}

function buildTransactItems(
  shared: EventSharedResources,
  tenantId: string,
  plan: readonly PlanEntry[],
): TransactWriteCommandInput["TransactItems"] {
  const items: TransactWriteCommandInput["TransactItems"] = [];
  for (const entry of plan) {
    items.push({
      Put: {
        TableName: shared.deploymentsTableName,
        Item: entry.item,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    if (entry.replacesJobId) {
      items.push({
        Delete: {
          TableName: shared.deploymentsTableName,
          Key: { PK: `DEPLOYMENT#${entry.replacesJobId}`, SK: "META" },
          ConditionExpression: "tenantId = :tenantId",
          ExpressionAttributeValues: { ":tenantId": tenantId },
        },
      });
    }
  }
  return items;
}

async function publishBulkDeployPlan(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdAt: string,
  plan: readonly PlanEntry[],
): Promise<PublishFailure[]> {
  const publish = Promise.all(publishBulkPlanEntries(shared, tenantId, eventId, plan));
  const [, failures] = await Promise.all([
    markBulkEventDeploying(shared, tenantId, eventId, createdAt),
    publish,
  ]);
  return failures.flat();
}

function publishBulkPlanEntries(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  plan: readonly PlanEntry[],
): Promise<PublishFailure[]>[] {
  if (shared.useBulkDistributedMap && shared.bulkDeployPayloadBucket.length > 0) {
    return [
      publishViaDistributedMap(shared, {
        batchId: ulid(),
        tenantId,
        eventId,
        details: plan.map(
          (entry) => JSON.parse(entry.entry.Detail ?? "{}") as DeployCreateRequestedDetail,
        ),
      }),
    ];
  }
  const chunks: Promise<PublishFailure[]>[] = [];
  for (let index = 0; index < plan.length; index += PUT_EVENTS_BATCH) {
    chunks.push(publishPlanChunk(shared, plan.slice(index, index + PUT_EVENTS_BATCH)));
  }
  return chunks;
}

async function markBulkEventDeploying(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdAt: string,
): Promise<void> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET #status = :deploying, updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#status = :draft OR #status = :ready OR #status = :deploying)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":draft": "DRAFT",
          ":ready": "READY",
          ":now": createdAt,
          ":tenantId": tenantId,
        },
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
    throw err;
  }
}

interface PublishFailure {
  readonly jobId: string;
  readonly reason: string;
}

/**
 * Issue #910 (#895 Phase 2.C.2.b): Distributed Map 経路。 deployment 配列を S3 に PutObject
 * (= 1 call で payload を整理)、 続いて 1 \`BulkDeployCreateRequested\` event を publish。
 * Step Functions State Machine 側で \`S3JsonItemReader\` が読んで Distributed Map で N×M
 * child execution を並列起動する (= PR #921 で構築済の foundation)。
 *
 * 失敗モード:
 *   - S3 PutObject 失敗 → 全 plan を FAILED に倒す (= 旧 path の "1 event publish 失敗時
 *     全件 FAILED" と同セマンティクス)
 *   - PutEvents 失敗 → 同上
 *   - State Machine 内 child 失敗 → 個別 deployment は child SM 内で FAILED に倒れる (=
 *     既存 DeployCreateStateMachine の挙動)。 親 Map は ToleratedFailure 未設定で全 item
 *     を最後まで試す
 */
async function publishViaDistributedMap(
  shared: EventSharedResources,
  args: {
    readonly batchId: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly details: readonly DeployCreateRequestedDetail[];
  },
): Promise<PublishFailure[]> {
  const { batchId, tenantId, eventId, details } = args;
  const s3Key = `batches/${batchId}/deployments.json`;
  // S3 PutObject: payload = deployment 配列。 Distributed Map の S3JsonItemReader が
  // この shape (= top-level array) を要求する。 Content-Type は明示しないと Step Functions
  // 側で text/plain と誤認することがあるので application/json を強制。
  try {
    await shared.s3.send(
      new PutObjectCommand({
        Bucket: shared.bulkDeployPayloadBucket,
        Key: s3Key,
        Body: JSON.stringify(details),
        ContentType: "application/json",
        // 短命 + バケット自体に lifecycle (7 日) が掛かっているので追加 expires は不要。
      }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return details.map((d) => ({
      jobId: d.jobId,
      reason: `S3 PutObject failed for bulk payload: ${reason}`,
    }));
  }

  // 1 BulkDeployCreateRequested event を publish。 EventBridge Rule (PR #922 で wire 済) が
  // BulkDeployCreateStateMachine を起動する。 親 1 execution = 1 batch、 child は item 数分。
  try {
    const out = await shared.events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: shared.eventBusName,
            Source: EVENT_SOURCE,
            DetailType: EVENT_DETAIL_TYPE_BULK_DEPLOY_CREATE_REQUESTED,
            Detail: JSON.stringify({
              batchId,
              tenantId,
              s3Bucket: shared.bulkDeployPayloadBucket,
              s3Key,
              itemCount: details.length,
            }),
            Resources: [`tenkacloud:bulk-deploy:${batchId}`, `tenkacloud:event:${eventId}`],
          },
        ],
      }),
    );
    if ((out.FailedEntryCount ?? 0) > 0) {
      const reason = out.Entries?.[0]?.ErrorMessage ?? "EventBridge PutEvents failed";
      return details.map((d) => ({
        jobId: d.jobId,
        reason: `BulkDeployCreateRequested publish failed: ${reason}`,
      }));
    }
    logDeployTrace("bulk-deploy.distributed_map.published", {
      correlationId: batchId,
      tenantId,
      eventId,
      itemCount: details.length,
      s3Bucket: shared.bulkDeployPayloadBucket,
      s3Key,
    });
    return [];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return details.map((d) => ({
      jobId: d.jobId,
      reason: `BulkDeployCreateRequested publish failed: ${reason}`,
    }));
  }
}

async function publishPlanChunk(
  shared: EventSharedResources,
  chunk: readonly PlanEntry[],
): Promise<PublishFailure[]> {
  try {
    const out = await shared.events.send(
      new PutEventsCommand({ Entries: chunk.map((p) => p.entry) }),
    );
    if ((out.FailedEntryCount ?? 0) === 0) return [];
    const failures = (out.Entries ?? [])
      .map((entry, i): PublishFailure | undefined =>
        entry.ErrorCode
          ? {
              jobId: chunk[i]?.item.jobId ?? "<unknown>",
              reason: `${entry.ErrorCode}: ${entry.ErrorMessage ?? "unknown error"}`,
            }
          : undefined,
      )
      .filter((f): f is PublishFailure => f !== undefined);
    return failures.length > 0
      ? failures
      : chunk.map((p) => ({ jobId: p.item.jobId, reason: "unknown error" }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return chunk.map((p) => ({ jobId: p.item.jobId, reason }));
  }
}

async function markPublishFailuresFailed(
  shared: EventSharedResources,
  tenantId: string,
  failures: readonly PublishFailure[],
  updatedAt: string,
): Promise<void> {
  await Promise.all(
    failures.map(async (failure) => {
      try {
        await shared.ddb.send(
          new UpdateCommand({
            TableName: shared.deploymentsTableName,
            Key: { PK: `DEPLOYMENT#${failure.jobId}`, SK: "META" },
            UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
            ConditionExpression: "tenantId = :tenantId AND #s = :pending",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":failed": "FAILED",
              ":pending": "PENDING",
              ":tenantId": tenantId,
              ":updatedAt": updatedAt,
              ":reason": `Failed to publish DeployCreateRequested event: ${failure.reason}`,
            },
          }),
        );
      } catch (err) {
        if (!(err instanceof Error) || err.name !== "ConditionalCheckFailedException") {
          throw err;
        }
      }
    }),
  );
}

/**
 * Phase 2.2 (Issue #459): result builder。`unverifiedAccounts` が空のときは
 * `unverified` / `unverifiedAccounts` フィールド自体を出さない (= 既存 client が
 * 後方互換)。あるときは sorted array で安定出力する (= operator UI 表示用)。
 */
function buildResult(args: {
  readonly eventId: string;
  readonly enqueued: number;
  readonly skipped: number;
  readonly unverifiedAccounts: Set<string>;
}): BulkDeployResult {
  const base: BulkDeployResult = {
    eventId: args.eventId,
    enqueued: args.enqueued,
    skipped: args.skipped,
  };
  if (args.unverifiedAccounts.size === 0) return base;
  return {
    ...base,
    unverified: args.unverifiedAccounts.size,
    unverifiedAccounts: Array.from(args.unverifiedAccounts).sort(),
  };
}
