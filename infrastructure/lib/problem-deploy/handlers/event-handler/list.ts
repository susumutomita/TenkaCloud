import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { EventSharedResources } from "./shared.js";
import type {
  EventDeploymentSummary,
  EventDetail,
  EventItem,
  EventSummary,
  TeamItem,
  TeamSummary,
} from "./types.js";

const DEPLOYMENT_STATUS_VALUES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
] as const;
type DeploymentStatus = (typeof DEPLOYMENT_STATUS_VALUES)[number];

function parseDeploymentStatus(raw: unknown): DeploymentStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return (DEPLOYMENT_STATUS_VALUES as readonly string[]).includes(raw)
    ? (raw as DeploymentStatus)
    : undefined;
}

export interface ListEventsRequest {
  readonly tenantId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListEventsResponse {
  readonly items: readonly EventSummary[];
  readonly nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 不正な cursor は無視して最初から
  }
  return undefined;
}

function toSummary(item: Partial<EventItem>): EventSummary {
  return {
    eventId: String(item.eventId ?? ""),
    name: String(item.name ?? ""),
    status: (item.status ?? "DRAFT") as EventSummary["status"],
    teamCount: Number(item.teamCount ?? 0),
    problemCount: Array.isArray(item.problems) ? item.problems.length : 0,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
    startsAt: typeof item.startsAt === "string" ? item.startsAt : undefined,
    endsAt: typeof item.endsAt === "string" ? item.endsAt : undefined,
    scoringLocked: item.scoringLocked === true ? true : undefined,
    scoringLockedAt: typeof item.scoringLockedAt === "string" ? item.scoringLockedAt : undefined,
  };
}

/**
 * 指定 tenant の Event 一覧を新しい順に返す (GSI1: TENANT#<tenantId> / createdAt)。
 */
export async function listEvents(
  shared: EventSharedResources,
  req: ListEventsRequest,
): Promise<ListEventsResponse> {
  const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const exclusiveStartKey = req.cursor ? decodeCursor(req.cursor) : undefined;

  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.eventsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `TENANT#${req.tenantId}` },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const items = (out.Items ?? []).map((i) => toSummary(i as Partial<EventItem>));
  const nextCursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey as Record<string, unknown>)
    : undefined;
  return { items, nextCursor };
}

/**
 * 指定 eventId の Event 詳細 + Teams 一覧を返す。`tenantId` 不一致は undefined (404 相当)。
 *
 * teams[].teamLoginKey は **詳細経路でのみ露出** (operator が hand-off に使うため)。
 * 一覧経路 (`listEvents`) では teams 自体を返さない。
 */
export async function getEventDetail(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
): Promise<EventDetail | undefined> {
  // Event Get と Teams Query は依存関係なし → 並列発火でラウンドトリップを 1 回分節約。
  // Event / Teams / Deployments を並列発火。Deployments は競技者が PATCH /portal/me で
  // 設定した displayTeamName を引くため必要 (TeamsTable には participant が直接書け
  // ないので displayName が常に空のままになる、という ADR-004 Phase 2c 統合ギャップ
  // への補正)。GSI1 = TENANT#<tenantId> 全件取得 → eventId で in-memory filter。
  const [eventOut, teamsOut, deploymentsOut] = await Promise.all([
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
        ExpressionAttributeValues: {
          ":pk": `EVENT#${eventId}`,
          ":tprefix": "TEAM#",
        },
      }),
    ),
    shared.ddb.send(
      new QueryCommand({
        TableName: shared.deploymentsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        // problemId / jobId / status は per-problem deploy 状況を組み立てるのに必要。
        // displayTeamName は既存の teams[].displayName 上書き用。
        ProjectionExpression: "teamId, eventId, displayTeamName, problemId, jobId, #s",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    ),
  ]);
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event) return undefined;
  if (event.tenantId !== tenantId) return undefined;

  const teamItems = (teamsOut.Items ?? []) as Partial<TeamItem>[];

  // teamId → displayTeamName の最新値 map を作る。同じ team の N 行のうち、operator
  // 起動時には全て同じ値で埋まる (update.ts が Promise.all で全行を更新するため)。
  // 念のため最後に拾った非空文字列を採用 (=「設定済」優先)。
  const displayNameByTeamId = new Map<string, string>();
  // problemId → deployment summary[]。本 event の deployment のみ集める。
  const deploymentsByProblem: Record<string, EventDeploymentSummary[]> = {};
  for (const d of deploymentsOut.Items ?? []) {
    const row = d as {
      teamId?: unknown;
      eventId?: unknown;
      displayTeamName?: unknown;
      problemId?: unknown;
      jobId?: unknown;
      status?: unknown;
    };
    if (row.eventId !== eventId) continue;
    if (typeof row.teamId === "string" && typeof row.displayTeamName === "string") {
      if (row.displayTeamName.length > 0) {
        displayNameByTeamId.set(row.teamId, row.displayTeamName);
      }
    }
    if (
      typeof row.problemId !== "string" ||
      typeof row.jobId !== "string" ||
      typeof row.teamId !== "string"
    ) {
      continue;
    }
    const status = parseDeploymentStatus(row.status);
    if (!status) continue;
    const list = deploymentsByProblem[row.problemId] ?? [];
    list.push({ jobId: row.jobId, teamId: row.teamId, status });
    deploymentsByProblem[row.problemId] = list;
  }

  const teams: TeamSummary[] = teamItems.map((t) => {
    const teamId = String(t.teamId ?? "");
    const fromTeamsTable = typeof t.displayName === "string" ? t.displayName : undefined;
    return {
      teamId,
      internalSlug: String(t.internalSlug ?? ""),
      // 競技者が portal で設定した名前 (Deployments 経由) を優先、無ければ
      // TeamsTable.displayName (operator 事前設定があれば)、それも無ければ undefined。
      displayName: displayNameByTeamId.get(teamId) ?? fromTeamsTable,
      teamLoginKey: typeof t.teamLoginKey === "string" ? t.teamLoginKey : undefined,
      // #528: team の deploy 先 AWS Account ID。旧 Event は undefined。
      awsAccountId: typeof t.awsAccountId === "string" ? t.awsAccountId : undefined,
    };
  });

  const summary = toSummary(event);
  return {
    ...summary,
    problems: Array.isArray(event.problems) ? (event.problems as EventDetail["problems"]) : [],
    teams,
    deploymentsByProblem,
  };
}
