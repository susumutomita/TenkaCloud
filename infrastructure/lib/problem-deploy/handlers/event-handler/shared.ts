import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { getEnv } from "../../../helper-functions.js";
import type { EffectiveCatalogProvenance } from "../../../problem-pack/effective-catalog.js";
import type { ProblemDisruptionEntry } from "../../../utils/discover-problems-catalog.js";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
import type { EventsRepository } from "../../control-data/events-repository.js";
import {
  type ControlDataRepositories,
  controlDataRuntime,
  resolveControlDataRepositories,
} from "../../control-data/runtime-repositories.js";
import type { TeamsRepository } from "../../control-data/teams-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseProblemsCatalog } from "../shared/catalog.js";

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
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly deploymentsTableName: string;
  readonly competitorAccountsTableName: string;
  /** Issue #888: disruption audit + idempotency 用 DDB table。 deploy 時に env で wire。 */
  readonly disruptionsTableName: string;
  readonly eventBusName: string;
  readonly env: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly s3: S3Client;
  /** [ADR-037 Slice 2] recurring disruption の早期解除 (DeleteSchedule) 用 aws-scheduler client。 */
  readonly scheduler: SchedulerClient;
  readonly problemsCatalog: Readonly<Record<string, string>>;
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
}

export function buildEventSharedResources(): EventSharedResources {
  return {
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    teamsTableName: getEnv("TEAMS_TABLE_NAME"),
    deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    competitorAccountsTableName: getEnv("COMPETITOR_ACCOUNTS_TABLE_NAME"),
    disruptionsTableName: getEnv("DISRUPTIONS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    env: getEnv("DEPLOY_ENVIRONMENT"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    problemsDisruptions: parseProblemsDisruptions(process.env.BATTLE_PROBLEMS_DISRUPTIONS),
    problemsProvenance: parseProblemsProvenance(process.env.BATTLE_PROBLEMS_PROVENANCE),
    bulkDeployPayloadBucket: process.env.BULK_DEPLOY_PAYLOAD_BUCKET ?? "",
    useBulkDistributedMap:
      (process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP ?? "").toLowerCase() === "true",
  };
}

/**
 * [ADR-047] 毎分 reconciler (generic-scoring Lambda) から `bulkTeardownEvent` を呼ぶための
 * 最小 `EventSharedResources`。 teardown は Events / Deployments / CompetitorAccounts table と
 * deploy event bus だけを使う (= Teams / problem catalog / S3 は不要)。 未使用 field は安全な
 * placeholder で埋める。
 *
 * **防御設計**: `COMPETITOR_ACCOUNTS_TABLE_NAME` env が未配線なら `undefined` を返す。 これにより
 * オーナーが generic-scoring Lambda に CompetitorAccounts read grant + env を足す前は scheduled
 * teardown が dormant になり、 毎分 tick / 採点を一切壊さない。
 */
export function buildScheduledTeardownResources(): EventSharedResources | undefined {
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  if (
    !competitorAccountsTableName ||
    !eventsTableName ||
    !deploymentsTableName ||
    !eventBusName ||
    !env
  ) {
    return undefined;
  }
  return {
    eventsTableName,
    deploymentsTableName,
    competitorAccountsTableName,
    eventBusName,
    env,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    // teardown 未使用 field の placeholder (bulkTeardownEvent は参照しない)。
    teamsTableName: "",
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    problemsCatalog: {},
    problemsDisruptions: {},
    problemsProvenance: {},
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
  };
}

/**
 * [ADR-047 follow-up] 毎分 reconciler (generic-scoring Lambda) から `bulkDeployEvent` を呼ぶための
 * `EventSharedResources` (teardown の鏡像)。 bulk deploy は Events / Deployments / Teams /
 * CompetitorAccounts table と deploy event bus + problem catalog を使う (= teardown より広い)。
 *
 * **防御設計**: deploy に必須な env (`TEAMS_TABLE_NAME` + `BATTLE_PROBLEMS_CATALOG` を含む) が
 * 1 つでも欠けると `undefined` を返す。 これにより generic-scoring Lambda に Teams read grant +
 * catalog 配線が無い間は scheduled deploy が dormant になり、 毎分 tick / 採点を一切壊さない
 * (= teardown 配線 (#1910) と同じ段階的有効化モデル)。 `bulkDeployEvent` は teams を Query し
 * problemsCatalog で problemId→problemDir を解決するため、 teardown の placeholder では不足する。
 */
export function buildScheduledDeployResources(): EventSharedResources | undefined {
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const teamsTableName = process.env.TEAMS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  const problemsCatalog = parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG);
  if (
    !competitorAccountsTableName ||
    !eventsTableName ||
    !deploymentsTableName ||
    !teamsTableName ||
    !eventBusName ||
    !env ||
    Object.keys(problemsCatalog).length === 0
  ) {
    return undefined;
  }
  return {
    eventsTableName,
    deploymentsTableName,
    teamsTableName,
    competitorAccountsTableName,
    eventBusName,
    env,
    problemsCatalog,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    // deploy 未使用 field の placeholder (bulkDeployEvent fan-out 経路は参照しない)。
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    problemsDisruptions: {},
    problemsProvenance: {},
    // Distributed Map 経路は EventApiLambda 専用 (= S3 bucket env)。 reconciler は旧 fan-out
    // 経路 (N×M DeployCreateRequested publish) を使うので bucket 不要 / flag は false 固定。
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
  };
}

/**
 * [ADR-049 §5.1] Events **かつ** Teams aggregate を読む handler 向けの repository seam。
 *
 * `event-handler/list.ts` の `getEventDetail` と同型 (= 同じ `shared.ddb` / table 名を渡す)。
 * default backend (`CONTROL_DATA_BACKEND` 未設定 = `dynamodb`) では従来と byte 互換の
 * GetCommand / QueryCommand を `shared.ddb` 経由で発火するので CFn 差分ゼロ。 cold-start の
 * client / token cache は resolver 内蔵 (`runtime-repositories.ts`)。 Events META の point read は
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
  return resolveControlDataRepositories({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
    teamsTableName: shared.teamsTableName,
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
 * [#2450] cold-start cache 済みの async resolver (`controlDataRuntime`) 経由で解決するため、
 * `CONTROL_DATA_BACKEND=turso|sql` でも Mirrored で動作する (read は canonical DDB の passthrough)。
 * SSM GetParameter (WithDecryption) + libsql client 構築は turso 選択時のみ・Lambda instance
 * ごとに 1 回だけ (dynamodb default では SSM に触れず、 発火コマンドも従来と byte 互換)。
 * `Promise<EventsRepository>` を返すので caller は await してからメソッドを呼ぶ。
 */
export function resolveEventsRepository(
  shared: Pick<EventSharedResources, "ddb" | "eventsTableName">,
): Promise<EventsRepository> {
  return controlDataRuntime.resolveEventsRepository({
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
 * [#2450] events-only seam と同じく cold-start cache 済みの async resolver (`controlDataRuntime`)
 * 経由で解決するため、 `CONTROL_DATA_BACKEND=turso|sql` でも Mirrored で動作する。 `Promise` を返す。
 */
export function resolveTeamsRepository(shared: EventSharedResources): Promise<TeamsRepository> {
  return controlDataRuntime.resolveTeamsRepository({
    ddb: shared.ddb,
    teamsTableName: shared.teamsTableName,
  });
}

/**
 * [Issue #2441 / Phase B1] Deployments READ seam for event-handler modules.
 *
 * Default backend stays DynamoDB and emits the same GSI1/base-table reads through
 * the same injected DocumentClient. `CONTROL_DATA_BACKEND=turso/sql` is the
 * known B4 constraint: the control-data factory fails loudly until the SQL
 * Deployments backend exists.
 *
 * [#2467-era runtime] Delegates to the cold-start-cached `controlDataRuntime`
 * (mirror of {@link resolveEventsRepository} / {@link resolveTeamsRepository}),
 * so `Promise<DeploymentsRepository>` — caller must await before use.
 */
export function resolveDeploymentsRepository(
  shared: Pick<EventSharedResources, "ddb" | "deploymentsTableName">,
): Promise<DeploymentsRepository> {
  return controlDataRuntime.resolveDeploymentsRepository({
    ddb: shared.ddb,
    deploymentsTableName: shared.deploymentsTableName,
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
 * 内部的に GSI1 (TENANT#<tenantId>) を query し、`FilterExpression` で eventId 一致だけ
 * を返す。Filter は post-read のため RCU は変わらないが、ネットワーク転送 + Lambda 内
 * 処理量は削減できる (= ~750 行規模で意味のある差)。
 *
 * Phase 3+ で eventId 専用 GSI に切り替えれば 1 query で済むが、現状は単一 tenant 内
 * 全 deployment が <100 程度の運用想定で十分。Phase 2a の bulk-delete から、Phase 2c
 * 経由の schedule (eventStartsAt 伝播) まで同じ query が必要なので 1 箇所に集約。
 */
export async function queryDeploymentsByEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  projectionExpression?: string,
): Promise<Partial<DeploymentItem>[]> {
  if (projectionExpression === undefined) {
    const repository = await resolveDeploymentsRepository(shared);
    return [...(await repository.listByTenantAndEvent(tenantId, eventId))];
  }

  // Issue #670: DDB は `status` 等の reserved word を ProjectionExpression / FilterExpression
  // / UpdateExpression 全てで alias 必須。 caller が `#s` を含む projection を渡すケース
  // (= bulk-deploy.ts が `jobId, teamId, problemId, #s` で呼ぶ) を黙ってサポートするため、
  // alias を本 helper 側で定義する。 caller が `#s` を使わなくても extra alias は ignored。
  //
  // #1797: GSI1PK=TENANT#<id> パーティションが 1MB を超えると Query は LastEvaluatedKey を
  // 返してページ分割する。1 ページ目だけ読むと後続ページの deployment を取りこぼし、teardown
  // (bulk-delete) / end-event / schedule 伝播 / bulk-deploy の既存検知が黙って漏れる
  // (= 対象 stack が enqueue されず orphan 化)。FilterExpression(eventId) は各ページ内で
  // 適用されるので、目的 event の行が後続ページに居ると完全に missed。全ページを drain する。
  const items: Partial<DeploymentItem>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await shared.ddb.send(
      new QueryCommand({
        TableName: shared.deploymentsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        FilterExpression: "eventId = :ev",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${tenantId}`,
          ":ev": eventId,
        },
        ...(projectionExpression
          ? {
              ProjectionExpression: projectionExpression,
              ...(projectionExpression.includes("#s")
                ? { ExpressionAttributeNames: { "#s": "status" } }
                : {}),
            }
          : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((out.Items ?? []) as Partial<DeploymentItem>[]));
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}
