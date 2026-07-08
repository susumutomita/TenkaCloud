import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemEndpointSlot, parseEndpointsEnv } from "../../../utils/endpoints-metadata.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import { type ProblemWriteup, parseWriteupsEnv } from "../../../utils/writeup-metadata.js";
import {
  createFeatureFlagsRepository,
  type FeatureFlagsRepository,
} from "../../control-data/feature-flags-repository.js";
import {
  createNotificationsRepository,
  type NotificationsRepository,
} from "../../control-data/notifications-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * Participant Lambda は DDB Query しか叩かない。Deploy Worker / API が使う
 * `DeploySharedResources` (EventBridge クライアントを含む) を流用すると
 * 不要な SDK 初期化と未使用 env (`DEPLOY_EVENT_BUS_NAME`) を要求してしまうため、
 * 必要最小限の shape を独自に定義する。
 */
export interface ParticipantSharedResources {
  readonly tableName: string;
  /**
   * Events table 名 (ADR-006 Notifications で参照)。`GET /portal/me/notifications` は
   * Notifications aggregate seam ({@link resolveNotificationsRepository}) 経由で 1 event 分の
   * 通知を読む。default backend では `PK=EVENT#<eventId>` partition の通知行を Query する
   * (物理キー導出は seam の実装詳細)。CDK 側で IAM `dynamodb:Query` を Events table にも付与する。
   */
  readonly eventsTableName: string;
  /**
   * ADR-012 Phase 3.A: Endpoint registry table 名 (= ProblemEndpoints)。
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
   * ADR-012 Phase 3.A: `{ [problemId]: ProblemEndpointSlot[] }`。endpoint registry
   * route が default URL 算出に使う。`endpoints[]` 宣言の無い problem は key ごと不在。
   */
  readonly problemsEndpoints: Record<string, readonly ProblemEndpointSlot[]>;
}

export function buildParticipantSharedResources(): ParticipantSharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    // 未配線時 (= legacy stack) でも import が落ちないよう env 必須にしない (= 空文字)。
    // route 側で空チェックして 503 を返す経路にする。
    endpointsTableName: process.env.PROBLEM_ENDPOINTS_TABLE_NAME ?? "",
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    problemsScoring: parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING),
    problemsWriteups: parseWriteupsEnv(process.env.BATTLE_PROBLEMS_WRITEUPS),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
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
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
    }),
  );
  return (out.Items ?? []) as Partial<DeploymentItem>[];
}

/**
 * [ADR-049 §5.1 / #2439] Notifications aggregate 専用 read seam
 * (admin-insight/event-handler の `resolveEventsRepository` と同型)。 default backend
 * (`CONTROL_DATA_BACKEND` 未設定 = dynamodb) では従来と byte 互換の Query を `shared.ddb`
 * 経由で発火する。 participant portal は通知の read しか行わないため sync factory の
 * aggregate-only seam で十分。
 *
 * **[#2437 と同じ既知の制約]** この resolver は sync factory なので Turso/SQL executor を
 * 組み立てられない。 `CONTROL_DATA_BACKEND=turso|sql` が渡ると `createNotificationsRepository`
 * が `deps.sql` 欠落で fail-loud に throw する (= 意図的。 silent に DynamoDB へ fallback
 * しない — repo の "no silent fallbacks" 原則)。 participant Lambda の SQL 有効化が必要に
 * なったら event-handler の async `resolveEventRepositories` と同様に SSM + libsql client 構築を
 * 別途スレッドすること (この sync 版のまま turso を有効化してはいけない)。
 */
export function resolveNotificationsRepository(
  shared: Pick<ParticipantSharedResources, "ddb" | "eventsTableName">,
): NotificationsRepository {
  return createNotificationsRepository(process.env.CONTROL_DATA_BACKEND, {
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}

/**
 * [ADR-049 §5.1 / #2439] TenantFeatureFlags aggregate 専用 read seam
 * ({@link resolveNotificationsRepository} の鏡像)。 challenge access guard の Gate flag 判定が
 * seam 経由で per-tenant flag 行を読む。 default backend では従来と byte 互換の GetCommand を
 * `shared.ddb` 経由で発火する。 sync factory の既知の制約は上記と同じ (turso は fail-loud)。
 */
export function resolveFeatureFlagsRepository(
  shared: Pick<ParticipantSharedResources, "ddb" | "eventsTableName">,
): FeatureFlagsRepository {
  return createFeatureFlagsRepository(process.env.CONTROL_DATA_BACKEND, {
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}
