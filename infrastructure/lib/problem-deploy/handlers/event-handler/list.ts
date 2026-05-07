import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { EventSharedResources } from "./shared.js";
import type { EventDetail, EventItem, EventSummary, TeamItem, TeamSummary } from "./types.js";

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
  // 不正 eventId のとき teams query が無駄になるが、空 partition の query は 1 RCU 程度。
  // teams.max(100) なので 1 query で確定。
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
        ExpressionAttributeValues: {
          ":pk": `EVENT#${eventId}`,
          ":tprefix": "TEAM#",
        },
      }),
    ),
  ]);
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event) return undefined;
  if (event.tenantId !== tenantId) return undefined;

  const teamItems = (teamsOut.Items ?? []) as Partial<TeamItem>[];
  const teams: TeamSummary[] = teamItems.map((t) => ({
    teamId: String(t.teamId ?? ""),
    internalSlug: String(t.internalSlug ?? ""),
    displayName: typeof t.displayName === "string" ? t.displayName : undefined,
    teamLoginKey: typeof t.teamLoginKey === "string" ? t.teamLoginKey : undefined,
  }));

  const summary = toSummary(event);
  return {
    ...summary,
    problems: Array.isArray(event.problems) ? (event.problems as EventDetail["problems"]) : [],
    teams,
  };
}
