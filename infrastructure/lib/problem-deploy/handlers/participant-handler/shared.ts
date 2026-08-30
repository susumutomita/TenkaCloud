import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemEndpointSlot, parseEndpointsEnv } from "../../../utils/endpoints-metadata.js";
import { readCatalogBlob } from "../../../utils/read-catalog-blob.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import { type ProblemWriteup, parseWriteupsEnv } from "../../../utils/writeup-metadata.js";
import type {
  DeploymentsQueryPort,
  DeploymentsRepository,
} from "../../control-data/deployments-repository.js";
import type { FeatureFlagsRepository } from "../../control-data/feature-flags-repository.js";
import type { NotificationsRepository } from "../../control-data/notifications-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * Participant Lambda は DDB Query しか叩かない。Deploy Worker / API が使う
 * `DeploySharedResources` (EventBridge クライアントを含む) を流用すると
 * 不要な SDK 初期化と未使用 env (`DEPLOY_EVENT_BUS_NAME`) を要求してしまうため、
 * 必要最小限の shape を独自に定義する。
 */
export interface ParticipantSharedResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly tableName: string;
  /**
   * Events table 名 (Notifications で参照)。`GET /portal/me/notifications` は
   * Notifications aggregate seam ({@link resolveNotificationsRepository}) 経由で 1 event 分の
   * 通知を読む。default backend では `PK=EVENT#<eventId>` partition の通知行を Query する
   * (物理キー導出は seam の実装詳細)。CDK 側で IAM `dynamodb:Query` を Events table にも付与する。
   */
  readonly eventsTableName: string;
  /**
   * Endpoint registry table 名 (ProblemEndpoints)。
   * `/portal/me/problems/:problemId/endpoints` 系 route が読み書きする。
   * 未配線時 (= 古い deploy / Phase 3.A 適用前) は空文字、route 側で 503 ガード。
   */
  readonly endpointsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /** SSM SecureString client for tenant ExternalId lookup used by AWS Console SSO. */
  readonly ssm?: Pick<SSMClient, "send">;
  /** Deploy environment segment used in `/{env}/tenants/{tenantId}/external-id`. */
  readonly env?: string;
  /** `{ [problemId]: ProblemScoringMetadata }`。submit-flag が採点に使う。 */
  readonly problemsScoring: Record<string, ProblemScoringMetadata>;
  /** Issue #2191: backend-only post-solve explanations. */
  readonly problemsWriteups?: Record<string, ProblemWriteup>;
  /**
   * `{ [problemId]: ProblemEndpointSlot[] }`。endpoint registry
   * route が default URL 算出に使う。`endpoints[]` 宣言の無い problem は key ごと不在。
   */
  readonly problemsEndpoints: Record<string, readonly ProblemEndpointSlot[]>;
}

export function buildParticipantSharedResources(
  runtime: ControlDataRuntime,
): ParticipantSharedResources {
  return {
    runtime,
    // [Issue #2441 / Phase B PR-6] pure SQL backend (turso) では Deployments table 自体が
    // synth されず env も配線されないため、module-load を fail-fast にすると cold start が落ちる。
    // 空文字 default に緩和し、dynamodb backend の誤設定は runtime resolver
    // (`runtime-repositories.ts`) が fail loud に受ける (= silent fallback にはならない、
    // EVENTS_TABLE_NAME と同じ緩和)。
    tableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
    // [Issue #2440] pure SQL backend (turso) では Events table
    // 自体が synth されず env も配線されないため、module-load を fail-fast にすると cold start
    // が落ちる。空文字 default に緩和し、dynamodb backend の誤設定は runtime resolver
    // (`runtime-repositories.ts`) が fail loud に受ける (= silent fallback にはならない)。
    eventsTableName: process.env.EVENTS_TABLE_NAME ?? "",
    // 未配線時 (= legacy stack) でも import が落ちないよう env 必須にしない (= 空文字)。
    // route 側で空チェックして 503 を返す経路にする。
    endpointsTableName: process.env.PROBLEM_ENDPOINTS_TABLE_NAME ?? "",
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    problemsScoring: parseScoringEnv(readCatalogBlob("BATTLE_PROBLEMS_SCORING")),
    problemsWriteups: parseWriteupsEnv(readCatalogBlob("BATTLE_PROBLEMS_WRITEUPS")),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
  };
}

export interface ParticipantDeploymentsTableSharedResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly tableName: string;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
}

/**
 * [Issue #2441 / Phase B1] Deployments READ seam for participant-handler modules.
 *
 * Default backend stays DynamoDB and emits the same GSI2/base-table reads through
 * the same injected DocumentClient. `CONTROL_DATA_BACKEND=turso` is the
 * known B4 constraint: the control-data factory fails loudly until the SQL
 * Deployments backend exists.
 *
 * [#2467-era runtime] Delegates to the cold-start-cached injected `shared.runtime`,
 * so `Promise<DeploymentsRepository>` — caller must await before use.
 */
export function resolveDeploymentsRepository(
  shared: ParticipantDeploymentsTableSharedResources,
): Promise<DeploymentsRepository> {
  return shared.runtime.resolveDeploymentsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    deploymentsTableName: shared.tableName,
  });
}

/** Event status lookup used only by coordination writes to reject torn-down events. */
export function resolveParticipantEventsRepository(shared: ParticipantSharedResources) {
  return shared.runtime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}

function rehydrateDeploymentKeys(
  item: Awaited<ReturnType<DeploymentsRepository["listByTeamLoginKey"]>>[number],
  teamLoginKey: string,
): Partial<DeploymentItem> {
  return {
    PK: `DEPLOYMENT#${item.jobId}`,
    SK: "META",
    GSI1PK: `TENANT#${item.tenantId}`,
    GSI1SK: item.createdAt,
    GSI2PK: `TEAMKEY#${teamLoginKey}`,
    GSI2SK: item.createdAt,
    ...item,
  };
}

/**
 * teamLoginKey で GSI2 を Query して team の全 deployment 行を返す共通 helper
 * (lookup / update / submit-flag が同じ query を使うため)。
 */
export async function queryTeamItems(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<Partial<DeploymentItem>[]> {
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository(shared);
  const rows = await repository.listByTeamLoginKey(teamLoginKey);
  // queryTeamItems is still shared with B2/B3 write handlers. The repository
  // returns domain records (no physical keys), so keep this legacy helper's
  // return shape stable by reconstructing the META keys its write callers use.
  return rows.map((item) => rehydrateDeploymentKeys(item, teamLoginKey));
}

/**
 * [#2439] Notifications aggregate 専用 read seam
 * (admin-insight/event-handler の `resolveEventsRepository` と同型)。 default backend
 * (`CONTROL_DATA_BACKEND` 未設定 = dynamodb) では従来と byte 互換の Query を `shared.ddb`
 * 経由で発火する。 participant portal は通知の read しか行わない。
 *
 * [#2450] cold-start cache 済みの async resolver (injected `shared.runtime`) 経由で解決するため
 * `CONTROL_DATA_BACKEND=turso` (pure SQL) でも動作する。
 * SSM GetParameter + libsql client 構築は turso 選択時のみ・Lambda instance ごとに 1 回だけ
 * (dynamodb default では SSM に触れず byte 互換)。 `Promise` を返すので caller は await する。
 */
export function resolveNotificationsRepository(
  shared: Pick<ParticipantSharedResources, "runtime" | "ddb" | "eventsTableName">,
): Promise<NotificationsRepository> {
  return shared.runtime.resolveNotificationsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}

/**
 * [#2439] TenantFeatureFlags aggregate 専用 read seam
 * ({@link resolveNotificationsRepository} の鏡像)。 challenge access guard の Gate flag 判定が
 * seam 経由で per-tenant flag 行を読む。 default backend では従来と byte 互換の GetCommand を
 * `shared.ddb` 経由で発火する。 [#2450] notifications seam と同じく async resolver 経由なので
 * `CONTROL_DATA_BACKEND=turso` (pure SQL) でも動作する。 `Promise` を返す。
 */
export function resolveFeatureFlagsRepository(
  shared: Pick<ParticipantSharedResources, "runtime" | "ddb" | "eventsTableName">,
): Promise<FeatureFlagsRepository> {
  return shared.runtime.resolveFeatureFlagsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}
