import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { getEnv } from "../../../helper-functions.js";
import type { EffectiveCatalogProvenance } from "../../../problem-pack/effective-catalog.js";
import type { ProblemDisruptionEntry } from "../../../utils/discover-problems-catalog.js";
import {
  type ProblemsEducationGraph,
  parseProblemsEducationGraph,
} from "../../../utils/education-graph.js";
import { readCatalogBlob } from "../../../utils/read-catalog-blob.js";
import type { AdminAuditLogRepository } from "../../control-data/admin-audit-log-repository.js";
import { selectBackend } from "../../control-data/backend-config.js";
import type {
  DeploymentsQueryPort,
  DeploymentsRepository,
} from "../../control-data/deployments-repository.js";
import type { DisruptionsRepository } from "../../control-data/disruptions-repository.js";
import type { EventsRepository } from "../../control-data/events-repository.js";
import type {
  ControlDataRepositories,
  ControlDataRuntime,
} from "../../control-data/runtime-repositories.js";
import type { TeamsRepository } from "../../control-data/teams-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseProblemsCatalog } from "../shared/catalog.js";
import {
  makeProblemRuntimeDescriptorResolver,
  type ProblemRuntimeDescriptor,
} from "../shared/runtime/index.js";

/**
 * [Problem Packs / Issue #2096] Resolves a problem's provenance from the EVENT's
 * pinned catalog snapshot (#2095), keyed by the server-resolved (eventId,
 * problemId) — never from client input. Returns the snapshot provenance plus the
 * event's `catalogSnapshotId`, or `undefined` when the problem is not pinned to
 * the event. Default-undefined on `EventSharedResources` keeps every deployment
 * on the legacy (core, no-provenance) path byte-identically.
 */
export type DeploymentProvenanceResolver = (
  eventId: string,
  problemId: string,
) =>
  | { readonly provenance: EffectiveCatalogProvenance; readonly catalogSnapshotId: string }
  | undefined;

export type PackCatalogProvenance = Extract<
  EffectiveCatalogProvenance,
  { readonly source: "pack" }
>;

/**
 * Event handler Lambda module-scope で 1 度だけ build される shared resources。
 *
 * Phase 1 では Events / Teams のみ触るため deploymentsTableName / events client は
 * 不要だったが、Phase 2a の Bulk Deploy / Bulk Teardown 経路で Deployments table
 * への書き込み + EventBridge publish (DeployCreateRequested / DeployDeleteRequested)
 * が必要になったため拡張する。problemsCatalog は bulk deploy 時に problemId → problemDir
 * を解決するため env (BATTLE_PROBLEMS_CATALOG) から JSON parse する。
 *
 * Issue #459 / ADR-002 Phase 2.2: bulk-deploy が verified=true 行のみを許可する
 * gate を持つため、`CompetitorAccounts` table 名と SSM SecureString path 構築用の
 * `env` を share する。
 */
export interface EventSharedResources {
  /**
   * [#2527 Slice 4] Injected control-data runtime. The Lambda entrypoint
   * (`index.ts`) creates it via `createDefaultControlDataRuntime()` and every
   * repository seam below resolves through it — handler modules no longer
   * import the module-global singleton.
   */
  readonly runtime: ControlDataRuntime;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly deploymentsTableName: string;
  readonly competitorAccountsTableName: string;
  /** Issue #888: disruption audit + idempotency 用 DDB table。 deploy 時に env で wire。 */
  readonly disruptionsTableName: string;
  /**
   * Issue #950 (ADR-020 Phase D) / #2442 Phase C4: admin audit log 用 DDB table 名。 pure SQL
   * backend (turso) では table 自体が synth されず env も配線されないため、他の
   * `*TableName` field と同じ空文字 default 緩和を適用する (`resolveAdminAuditLogRepository` が
   * fail loud に受ける)。 tenant-scoped read route (`routes/audit-log.ts`) が使う。
   */
  readonly adminAuditLogTableName: string;
  readonly eventBusName: string;
  readonly env: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly s3: S3Client;
  /** [ADR-037 Slice 2] recurring disruption の早期解除 (DeleteSchedule) 用 aws-scheduler client。 */
  readonly scheduler: SchedulerClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /** Issue #2604: spoiler-safe education graph projection baked in at synth time. */
  readonly problemsEducationGraph?: ProblemsEducationGraph;
  /** Issue #888: problem metadata.json の `disruptions[]` 宣言 (problemId 毎)。 */
  readonly problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>;
  /**
   * Issue #2464: pack-only problem provenance burned in by esbuild define. Core problems are
   * absent, so `{}` means the runtime catalog has no active pack rows.
   */
  readonly problemsProvenance: Readonly<Record<string, PackCatalogProvenance>>;
  /**
   * Issue #910 (#895 Phase 2.C): bulk batch を Distributed Map 経路で実行するときの
   * S3 payload bucket。 未配線 (= 旧 fan-out 経路) なら空文字。
   */
  readonly bulkDeployPayloadBucket: string;
  /**
   * Issue #910: Distributed Map 経路を使うかどうかの feature flag (= env 由来)。
   * "true" のとき S3 PutObject + 1 BulkDeployCreateRequested publish に切替。
   * それ以外 (= "" / "false" / 未設定) なら旧 fan-out (= N×M 個の DeployCreateRequested
   * publish) を維持する。 段階移行で rollback 可能にする。
   */
  readonly useBulkDistributedMap: boolean;
  /**
   * [Problem Packs / Issue #2096] Resolves pack provenance from the event-pinned
   * catalog snapshot (#2095). Undefined (the default) keeps every deployment on
   * the legacy core/no-provenance path byte-identically; when wired, a
   * pack-sourced row records immutable provenance.
   */
  readonly resolveDeploymentProvenance?: DeploymentProvenanceResolver;
  readonly resolveProblemRuntimeDescriptor?: (
    problemId: string,
  ) => ProblemRuntimeDescriptor | undefined;
  /**
   * [#2571] non-AWS single-provider (gcp/azure/sakura) の per-team credential 読取用
   * SSM client。 `buildAdapterDependencies` に渡すと adapter dispatch (bulk deploy /
   * bulk teardown) が有効になる。 未配線 (undefined) の Lambda は plan-builder /
   * bulk-delete の v1 `unsupportedRuntime` 拒否 (#2563) のまま — loud かつ documented
   * な staged enablement (silent skip にはしない)。
   */
  readonly ssm?: Pick<SSMClient, "send">;
  /**
   * [#2571] Sakura AppRun REST の base URL override (env)。 deploy-handler の
   * `DeploySharedResources.sakuraAppRunBaseUrl` と同じ意味・同じ env 名
   * (`SAKURA_APPRUN_BASE_URL`) を共有する。
   */
  readonly sakuraAppRunBaseUrl?: string;
}

export function buildEventSharedResources(runtime: ControlDataRuntime): EventSharedResources {
  return {
    runtime,
    // [Issue #2440 / ADR-049 §5.1 Phase A5] pure SQL backend (turso) 選択時は Events/Teams
    // table 自体が synth されない (= env も未配線) ため、module-load を`getEnv`の fail-fast に
    // 委ねると cold start が Initialization Error で落ちる。空文字 default に緩和し、dynamodb
    // backend での誤設定 (= 本来 table がある構成で env を配線し忘れた場合) は runtime
    // resolver (`aggregate-resolvers.ts` の `requireDdbAndTableName`) が fail loud に受ける
    // (= silent fallback にはならない)。
    eventsTableName: process.env.EVENTS_TABLE_NAME ?? "",
    teamsTableName: process.env.TEAMS_TABLE_NAME ?? "",
    // [Issue #2441 / Phase B PR-6] pure SQL backend (turso) では Deployments table 自体が
    // synth されず env も配線されないため、module-load を `getEnv` の fail-fast に委ねると
    // cold start が Initialization Error で落ちる。空文字 default に緩和し、dynamodb
    // backend の誤設定は runtime resolver (`runtime-repositories.ts`) が fail loud に受ける
    // (= silent fallback にはならない、EVENTS_TABLE_NAME/TEAMS_TABLE_NAME と同じ緩和)。
    deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
    // [Issue #2442 / Phase C2] pure SQL backend (turso) では CompetitorAccounts table
    // 自体が synth されず env も配線されないため、`getEnv` の fail-fast に委ねると cold
    // start が Initialization Error で落ちる (= EventApiLambda 全 route が壊れる)。空文字
    // default に緩和し、dynamodb backend の誤設定は runtime resolver が fail
    // loud に受ける (= silent fallback にはならない、eventsTableName/deploymentsTableName
    // と同じ緩和)。
    competitorAccountsTableName: process.env.COMPETITOR_ACCOUNTS_TABLE_NAME ?? "",
    // [Issue #2442 / Phase C3] pure SQL backend (turso) では Disruptions table 自体が
    // synth されず env も配線されないため、`getEnv` の fail-fast に委ねると cold start が
    // Initialization Error で落ちる (= EventApiLambda 全 route が壊れる)。空文字 default に
    // 緩和し、dynamodb backend の誤設定は runtime resolver が fail loud に受ける
    // (= silent fallback にはならない、competitorAccountsTableName と同じ緩和)。
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    problemsEducationGraph: parseProblemsEducationGraph(
      readCatalogBlob("BATTLE_PROBLEMS_EDUCATION_GRAPH"),
    ),
    problemsDisruptions: parseProblemsDisruptions(process.env.BATTLE_PROBLEMS_DISRUPTIONS),
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      process.env.BATTLE_PROBLEMS_RUNTIMES,
    ),
    problemsProvenance: parseProblemsProvenance(process.env.BATTLE_PROBLEMS_PROVENANCE),
    bulkDeployPayloadBucket: process.env.BULK_DEPLOY_PAYLOAD_BUCKET ?? "",
    useBulkDistributedMap:
      (process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP ?? "").toLowerCase() === "true",
    // [#2571] non-AWS single-provider (gcp/azure/sakura) bulk deploy/teardown 用の
    // adapter dispatch context。 EventApiLambda は sakura/azure/gcp credential parameter
    // への ssm:GetParameter + kms:Decrypt を持つ (event-api-lambda.ts, deploy-api-lambda.ts
    // と同じ pattern)。
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

/**
 * [ADR-047] 毎分 reconciler (generic-scoring Lambda) から `bulkTeardownEvent` を呼ぶための
 * 最小 `EventSharedResources`。 teardown は Events / Deployments / CompetitorAccounts table と
 * deploy event bus だけを使う (= Teams / problem catalog / S3 は不要)。 未使用 field は安全な
 * placeholder で埋める。
 *
 * **防御設計**: default DynamoDB backend では従来どおり table env が 1 つでも欠ければ
 * `undefined` を返して dormant にする。pure Turso backend は table 自体を synth しないため、注入済み
 * `ControlDataRuntime` が SQL repository を解決し、backend 非依存の bus / environment だけで有効化する
 * (#2739)。unknown backend は `selectBackend` が fail loud に拒否する。
 */
export function buildScheduledTeardownResources(
  runtime: ControlDataRuntime,
): EventSharedResources | undefined {
  const backend = selectBackend(process.env);
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  if (!eventBusName || !env) return undefined;
  if (
    backend.kind === "dynamodb" &&
    (!competitorAccountsTableName || !eventsTableName || !deploymentsTableName)
  ) {
    return undefined;
  }
  return {
    runtime,
    // Pure Turso has no DynamoDB tables. Repository seams ignore these placeholders and resolve
    // through the injected SQL runtime; DynamoDB reached this point only with every name present.
    eventsTableName: eventsTableName ?? "",
    deploymentsTableName: deploymentsTableName ?? "",
    competitorAccountsTableName: competitorAccountsTableName ?? "",
    eventBusName,
    env,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    // teardown 未使用 field の placeholder (bulkTeardownEvent は参照しない)。
    teamsTableName: "",
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    problemsCatalog: {},
    problemsDisruptions: {},
    problemsProvenance: {},
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
    // [#2571] generic-scoring Lambda は sakura/azure/gcp credential parameter への
    // ssm:GetParameter + kms:Decrypt grant を既に持つ (generic-scoring-lambda.ts) ため、
    // ここで wire しても新規 IAM は不要。 未 wire のままだと非 AWS single-provider 行の
    // scheduled bulk teardown が adapter.destroy に届かず leak する (#2571 の core bug)。
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

/**
 * [ADR-047 follow-up] 毎分 reconciler (generic-scoring Lambda) から `bulkDeployEvent` を呼ぶための
 * `EventSharedResources` (teardown の鏡像)。 bulk deploy は Events / Deployments / Teams /
 * CompetitorAccounts table と deploy event bus + problem catalog を使う (= teardown より広い)。
 *
 * **防御設計**: problem catalog / bus / environment は backend 共通で必須。default DynamoDB
 * backend は Teams を含む 4 table env も必須のままにし、1 つでも欠ければ dormant にする。pure Turso
 * backend は table env を synth しないため、空 placeholder と注入済み SQL runtime で repository seam を
 * 通す (#2739)。`bulkDeployEvent` の problemId→problemDir 解決には catalog が引き続き必須。
 */
export function buildScheduledDeployResources(
  runtime: ControlDataRuntime,
): EventSharedResources | undefined {
  const backend = selectBackend(process.env);
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const teamsTableName = process.env.TEAMS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  const problemsCatalog = parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG);
  if (!eventBusName || !env || Object.keys(problemsCatalog).length === 0) return undefined;
  if (
    backend.kind === "dynamodb" &&
    (!competitorAccountsTableName || !eventsTableName || !deploymentsTableName || !teamsTableName)
  ) {
    return undefined;
  }
  return {
    runtime,
    // Pure Turso has no DynamoDB tables. Repository seams ignore these placeholders and resolve
    // through the injected SQL runtime; DynamoDB reached this point only with every name present.
    eventsTableName: eventsTableName ?? "",
    deploymentsTableName: deploymentsTableName ?? "",
    teamsTableName: teamsTableName ?? "",
    competitorAccountsTableName: competitorAccountsTableName ?? "",
    eventBusName,
    env,
    problemsCatalog,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    // deploy 未使用 field の placeholder (bulkDeployEvent fan-out 経路は参照しない)。
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    problemsDisruptions: {},
    problemsProvenance: {},
    // Distributed Map 経路は EventApiLambda 専用 (= S3 bucket env)。 reconciler は旧 fan-out
    // 経路 (N×M DeployCreateRequested publish) を使うので bucket 不要 / flag は false 固定。
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
    // [#2571] teardown 側と同じく generic-scoring Lambda は sakura/azure/gcp credential
    // grant を既に持つ。 未 wire のままだと scheduled bulk deploy が非 AWS single-provider
    // 問題の v1 unsupportedRuntime gate すら通らず silent skip する (#2571 の core bug —
    // resolveProblemRuntimeDescriptor 自体も未配線だったため)。
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      process.env.BATTLE_PROBLEMS_RUNTIMES,
    ),
  };
}

/**
 * [ADR-049 §5.1] Events **かつ** Teams aggregate を読む handler 向けの repository seam。
 *
 * `event-handler/list.ts` の `getEventDetail` と同型 (= 同じ `shared.ddb` / table 名を渡す)。
 * default backend (`CONTROL_DATA_BACKEND` 未設定 = `dynamodb`) では従来と byte 互換の
 * GetCommand / QueryCommand を `shared.ddb` 経由で発火するので CFn 差分ゼロ。 cold-start の
 * client / token cache は resolver 内蔵 (`sql-executor-cache.ts`)。 Events META の point read は
 * `repositories.events.getEvent(tenantId, eventId)` (= tenant scope + 404 判定を内包)、 event 配下
 * team 一覧は `repositories.teams.listTeamsByEvent(eventId)` を使う。
 *
 * teams repo も構築するため `teamsTableName` が必須 — Teams を読む handler
 * (list / progression-gate / disruption fire / bulk-deploy) 専用。 Events のみ読む handler
 * (= scheduled teardown 経路で `teamsTableName` が空になりうる bulk-teardown 等) は
 * {@link resolveEventsRepository} を使うこと。
 */
export function resolveEventRepositories(
  shared: EventSharedResources,
): Promise<ControlDataRepositories> {
  return shared.runtime.resolveRepositories({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
    teamsTableName: shared.teamsTableName,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

/**
 * [ADR-049 §5.1] Events aggregate **のみ** を触る、 Teams table を持たない実行 context 向けの
 * events-only seam。
 *
 * Teams repo を構築しない (= `teamsTableName` を要求しない) ため、 scheduled teardown 経路
 * (`buildScheduledTeardownResources` は `teamsTableName` を空にする) から呼ばれる bulk-teardown
 * や、 毎分 reconciler (generic-scoring Lambda) のような Events-only writer でも安全に使える。
 * default backend では従来と byte 互換の Get/UpdateCommand を `shared.ddb` 経由で発火する。
 *
 * [#2450] cold-start cache 済みの async resolver (injected `shared.runtime`) 経由で解決するため、
 * `CONTROL_DATA_BACKEND=turso` (pure SQL) でも動作する。
 * SSM GetParameter (WithDecryption) + libsql client 構築は turso 選択時のみ・Lambda instance
 * ごとに 1 回だけ (dynamodb default では SSM に触れず、 発火コマンドも従来と byte 互換)。
 * `Promise<EventsRepository>` を返すので caller は await してからメソッドを呼ぶ。
 */
export function resolveEventsRepository(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "eventsTableName">,
): Promise<EventsRepository> {
  return shared.runtime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}

/**
 * [ADR-049 §5.1] Teams aggregate **のみ** を読む handler 向けの teams-only seam (events-only の鏡像)。
 *
 * Events repo を構築しない (= `eventsTableName` を要求しない) ため、 Events table を参照しない
 * teams reader (= disruption fire の scope 解決) が余分な env 依存なしで使える。 default backend
 * では従来と byte 互換の QueryCommand (`PK = EVENT#<eventId> AND begins_with(SK, "TEAM#")`) を
 * `shared.ddb` 経由で発火し、 teamId 昇順の {@link TeamRecord}[] を返す。
 *
 * [#2450] events-only seam と同じく cold-start cache 済みの async resolver (injected `shared.runtime`)
 * 経由で解決するため、 `CONTROL_DATA_BACKEND=turso` (pure SQL) でも動作する。 `Promise` を返す。
 */
export function resolveTeamsRepository(shared: EventSharedResources): Promise<TeamsRepository> {
  return shared.runtime.resolveTeamsRepository({
    ddb: shared.ddb,
    teamsTableName: shared.teamsTableName,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

/**
 * [Issue #2441 / Phase B1] Deployments READ seam for event-handler modules.
 *
 * Default backend stays DynamoDB and emits the same GSI1/base-table reads through
 * the same injected DocumentClient. `CONTROL_DATA_BACKEND=turso` is the
 * known B4 constraint: the control-data factory fails loudly until the SQL
 * Deployments backend exists.
 *
 * [#2467-era runtime] Delegates to the cold-start-cached injected `shared.runtime`
 * (mirror of {@link resolveEventsRepository} / {@link resolveTeamsRepository}),
 * so `Promise<DeploymentsRepository>` — caller must await before use.
 */
export function resolveDeploymentsRepository(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "deploymentsTableName">,
): Promise<DeploymentsRepository> {
  return shared.runtime.resolveDeploymentsRepository({
    ddb: shared.ddb,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

/**
 * [Issue #2442 / Phase C3] Disruptions seam for event-handler modules (`disruption-fire.ts` /
 * `disruption-recurring.ts`). Default backend stays DynamoDB and emits the same Put/Get/Query/
 * Update reads through the same injected DocumentClient (byte-identical to the pre-seam inline
 * access — existing tests that mock `shared.ddb.send` pass unmodified).
 *
 * [#2467-era runtime] Delegates to the cold-start-cached injected `shared.runtime` (mirror of
 * {@link resolveDeploymentsRepository}), so `CONTROL_DATA_BACKEND=turso` works.
 * `Promise<DisruptionsRepository>` — caller must await before use.
 */
export function resolveDisruptionsRepository(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "disruptionsTableName">,
): Promise<DisruptionsRepository> {
  return shared.runtime.resolveDisruptionsRepository({
    ddb: shared.ddb,
    disruptionsTableName: shared.disruptionsTableName,
  });
}

/**
 * [Issue #2442 / Phase C4] AdminAuditLog seam for `routes/audit-log.ts` (tenant-scoped audit read
 * — Issue #1292). Default backend stays DynamoDB and emits the same Query through the same
 * injected DocumentClient (byte-identical to the pre-seam inline access). Delegates to the
 * cold-start-cached injected `shared.runtime` (mirror of {@link resolveDisruptionsRepository}), so
 * `CONTROL_DATA_BACKEND=turso` works.
 */
export function resolveAdminAuditLogRepository(
  shared: Pick<EventSharedResources, "runtime" | "ddb" | "adminAuditLogTableName">,
): Promise<AdminAuditLogRepository> {
  return shared.runtime.resolveAdminAuditLogRepository({
    ddb: shared.ddb,
    adminAuditLogTableName: shared.adminAuditLogTableName,
  });
}

function parseProblemsDisruptions(
  raw: string | undefined,
): Readonly<Record<string, readonly ProblemDisruptionEntry[]>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ProblemDisruptionEntry[]>;
    return parsed;
  } catch {
    return {};
  }
}

const PackCatalogProvenanceSchema = z
  .object({
    source: z.literal("pack"),
    packId: z.string().min(1),
    packVersion: z.string().min(1),
    contentDigest: z.string().min(1),
  })
  .strict();

const ProblemsProvenanceSchema = z.record(z.string(), PackCatalogProvenanceSchema);

function parseProblemsProvenance(
  raw: string | undefined,
): Readonly<Record<string, PackCatalogProvenance>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const result = ProblemsProvenanceSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Fall through to the warning below. The handler keeps the legacy core-only path.
  }
  console.warn("[event-handler] invalid BATTLE_PROBLEMS_PROVENANCE; using empty provenance map");
  return {};
}

/**
 * Deployments table から指定 event の全行を取得する共通 helper。
 *
 * [Issue #2441 / Phase B PR-6] repository seam (`listByTenantAndEvent`) 経由に統一。
 * 従来は呼び出し側が `projectionExpression` (= `"jobId, teamId, problemId, #s"`) を渡すと
 * 本 helper が raw `QueryCommand` を直接発火する近道を持っていたが、これは repository seam を
 * 迂回する唯一の残存経路で、pure SQL backend (turso) では table 自体が無いため
 * `TableName: ""` で即死していた (= B1〜B3 の 62-site 移行から漏れていた回帰)。default backend
 * では projection 分だけ読み取りペイロードが増えるが (GSI1 の full-item Query)、bulk-deploy /
 * scheduled auto-deploy は低頻度の operator 操作であり、backend 抽象を全サイトで貫徹する方を
 * 優先する。
 *
 * 内部的に GSI1 (TENANT#<tenantId>) + `eventId` filter で全 page drain する
 * (#1797: 1 ページ目だけ読むと後続ページの対象を取りこぼす)。Phase 2a の bulk-delete から
 * Phase 2c 経由の schedule (eventStartsAt 伝播) まで同じ query が必要なので 1 箇所に集約。
 */
export async function queryDeploymentsByEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
): Promise<Partial<DeploymentItem>[]> {
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository(shared);
  return [...(await repository.listByTenantAndEvent(tenantId, eventId))];
}
