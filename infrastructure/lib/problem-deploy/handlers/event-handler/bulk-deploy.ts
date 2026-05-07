import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { buildStackPrefix, slugify } from "../deploy-handler/naming.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";
import type { EventSharedResources } from "./shared.js";
import type { EventItem, EventProblemTarget, TeamItem } from "./types.js";

/**
 * `POST /events/{eventId}/deploy` のレスポンス。N×M (teams × problems) の deployment
 * 行を作成し、既存の DeployCreateRequested 経路に fan-out した結果を返す。
 */
export interface BulkDeployResult {
  readonly eventId: string;
  readonly enqueued: number;
  /** 既存 deployment 行と問題 ID 衝突で skip された組み合わせ数 (再 deploy 防止)。 */
  readonly skipped: number;
}

export type BulkDeployOutcome = { kind: "ok"; result: BulkDeployResult } | { kind: "not_found" };

const TRANSACT_WRITE_BATCH = 25;
const PUT_EVENTS_BATCH = 10;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * `bulkDeployEvent` は Event / Teams を読み、選択された problems 全てに対して
 * teams × problems の deployment 行を一括 PUT し、既存 `DeployCreateRequested` を
 * 個別に publish する (= EventBridge fan-out)。
 *
 * 各 deployment 行は eventId / teamId / teamLoginKey (Team 行と同値) を持ち、
 * Phase 2c の Participant Portal は teamLoginKey で `team の全 deployment` を引ける。
 *
 * 既存 deployment と (eventId, teamId, problemId) が衝突する場合は idempotent に skip
 * する (`attribute_not_exists(PK)` の ConditionExpression)。
 *
 * `tenantId` mismatch / event 不在は `not_found`。teams / problems 両方 0 件はそのまま
 * `enqueued: 0` を返す (= operator の即時 dry-run 用途)。
 */
export async function bulkDeployEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<BulkDeployOutcome> {
  // Event Get と Teams Query は依存なし → Promise.all で 1 ラウンドトリップ節約。
  // 不正 eventId のとき teams query が無駄になるが空 partition で 1 RCU 程度。
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
  if (!event || event.tenantId !== tenantId) return { kind: "not_found" };

  const teams = (teamsOut.Items ?? []) as TeamItem[];
  const problems = (Array.isArray(event.problems) ? event.problems : []) as EventProblemTarget[];
  if (teams.length === 0 || problems.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + DEFAULT_TTL_MS);

  // teams × problems を全展開し、deployment 行 + publish entry を組み立てる。
  // shared.problemsCatalog (problemId → problemDir) に存在しない problemId は skip。
  const items: DeploymentItem[] = [];
  const entries: PutEventsRequestEntry[] = [];
  let skipped = 0;
  for (const team of teams) {
    for (const problem of problems) {
      const problemDir = shared.problemsCatalog[problem.problemId];
      if (!problemDir) {
        skipped++;
        continue;
      }
      const jobId = ulid();
      const namePrefix = buildStackPrefix(problem.problemId, team.internalSlug);
      const teamSlug = slugify(team.internalSlug);
      const item: DeploymentItem = {
        PK: `DEPLOYMENT#${jobId}`,
        SK: "META",
        GSI1PK: `TENANT#${tenantId}`,
        GSI1SK: createdAt,
        GSI2PK: `TEAMKEY#${team.teamLoginKey}`,
        GSI2SK: createdAt,
        jobId,
        problemId: problem.problemId,
        tenantId,
        awsAccountId: problem.defaultAwsAccountId,
        region: problem.defaultRegion,
        teamName: team.internalSlug,
        namePrefix,
        teamLoginKey: team.teamLoginKey,
        status: "PENDING",
        createdAt,
        updatedAt: createdAt,
        expiresAt,
        eventId,
        teamId: team.teamId,
      };
      items.push(item);

      const detail: DeployCreateRequestedDetail = {
        jobId,
        tenantId,
        problemId: problem.problemId,
        problemDir,
        teamSlug,
        namePrefix,
        region: problem.defaultRegion,
        awsAccountId: problem.defaultAwsAccountId,
      };
      entries.push({
        EventBusName: shared.eventBusName,
        Source: EVENT_SOURCE,
        DetailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
        Detail: JSON.stringify(detail),
        Resources: [`tenkacloud:deployment:${jobId}`],
      });
    }
  }

  if (items.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped } };
  }

  // DDB TransactWrite は 1 call 25 items まで。chunk を Promise.all で並列発火。
  // ConditionExpression で同 jobId 二重生成を防ぐ (ULID 衝突は実質起こらないが defense)。
  const transactChunks: Promise<unknown>[] = [];
  for (let i = 0; i < items.length; i += TRANSACT_WRITE_BATCH) {
    const chunk = items.slice(i, i + TRANSACT_WRITE_BATCH);
    const transact: TransactWriteCommandInput = {
      TransactItems: chunk.map((item) => ({
        Put: {
          TableName: shared.deploymentsTableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      })),
    };
    transactChunks.push(shared.ddb.send(new TransactWriteCommand(transact)));
  }
  await Promise.all(transactChunks);

  // EventBridge PutEvents は 1 call 10 entries まで。chunk を Promise.all で並列発火。
  // 途中で publish が失敗した chunk があると半端な行が残るが、operator が再度 deploy を
  // 呼ぶと既行は idempotent skip され、未 publish 分だけ publish される (= 結果整合性)。
  const putChunks: Promise<unknown>[] = [];
  for (let i = 0; i < entries.length; i += PUT_EVENTS_BATCH) {
    const chunk = entries.slice(i, i + PUT_EVENTS_BATCH);
    putChunks.push(shared.events.send(new PutEventsCommand({ Entries: chunk })));
  }
  await Promise.all(putChunks);

  return { kind: "ok", result: { eventId, enqueued: items.length, skipped } };
}
