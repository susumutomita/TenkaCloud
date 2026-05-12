import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AdminInsightSharedResources } from "./shared.js";

/**
 * Phase 1.B drill-down (ADR-011 / #598)。
 *
 * Tenant-scoped に Events / Teams / Deployments を read-only で集計し、System Admin の
 * 「tenant 行 click → events 一覧 → event 詳細 → deploy job 詳細」 という UX を 1 度も
 * ログインし直さず通すために必要な小さい read API 群。
 *
 * 設計判断 (ADR-011 残部):
 * - **teamLoginKey は black-out**: System Admin 経路で短命 bearer を素通しさせると、
 *   admin が tenant を impersonate できる事になり権限境界が崩れる。EventDetail の
 *   teams[].teamLoginKey は本ファイルの中で `undefined` に潰す (`assertTeamLoginKeyHidden`
 *   helper で test pin する)。
 * - shape は application-admin-console 側の EventSummary / EventDetail と一致させる
 *   (= frontend を mirror で書けるようにする)。ただし黒塗りのため `teamLoginKey?: string`
 *   フィールドは shape 上は残し、値が常に `undefined` なところで防御する。
 */

type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";
type DeploymentStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "DELETING" | "DELETED";

const DEPLOYMENT_STATUS_VALUES: readonly DeploymentStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
];

function parseDeploymentStatus(raw: unknown): DeploymentStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return (DEPLOYMENT_STATUS_VALUES as readonly string[]).includes(raw)
    ? (raw as DeploymentStatus)
    : undefined;
}

export interface EventSummary {
  readonly eventId: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly teamCount: number;
  readonly problemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly scoringLocked?: boolean;
  readonly scoringLockedAt?: string;
}

export interface ListEventsResponse {
  readonly items: readonly EventSummary[];
  readonly nextCursor?: string;
}

export interface EventProblemTarget {
  readonly problemId: string;
  readonly defaultAwsAccountId?: string;
  readonly defaultRegion: string;
}

export interface TeamSummary {
  readonly teamId: string;
  readonly internalSlug: string;
  readonly displayName?: string;
  /**
   * 詳細経路でのみ persist 行に含まれる短命 bearer。
   * **本 admin-insight 経路では常に undefined にする** (ADR-011 D2: SystemAdmin は
   * tenant を impersonate しない権限境界)。Tests pin する。
   */
  readonly teamLoginKey?: string;
  readonly awsAccountId?: string;
}

export interface EventDeploymentSummary {
  readonly jobId: string;
  readonly teamId: string;
  readonly status: DeploymentStatus;
}

export interface EventDetail extends EventSummary {
  readonly problems: readonly EventProblemTarget[];
  readonly teams: readonly TeamSummary[];
  readonly deploymentsByProblem: Readonly<Record<string, readonly EventDeploymentSummary[]>>;
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
    // 不正 cursor は無視 (= 先頭から再開)。
  }
  return undefined;
}

function toEventSummary(item: Record<string, unknown>): EventSummary {
  const problems = item.problems;
  return {
    eventId: String(item.eventId ?? ""),
    name: String(item.name ?? ""),
    status: (item.status ?? "DRAFT") as EventStatus,
    teamCount: Number(item.teamCount ?? 0),
    problemCount: Array.isArray(problems) ? problems.length : 0,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
    startsAt: typeof item.startsAt === "string" ? item.startsAt : undefined,
    endsAt: typeof item.endsAt === "string" ? item.endsAt : undefined,
    scoringLocked: item.scoringLocked === true ? true : undefined,
    scoringLockedAt: typeof item.scoringLockedAt === "string" ? item.scoringLockedAt : undefined,
  };
}

export interface ListEventsRequest {
  readonly tenantId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * 指定 tenant の Event 一覧を新しい順に返す (GSI1: TENANT#<tenantId> / createdAt)。
 * application-admin-console の `listEvents` と同等の shape。
 */
export async function listEventsForTenant(
  shared: AdminInsightSharedResources,
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

  const items = (out.Items ?? []).map((i) => toEventSummary(i as Record<string, unknown>));
  const nextCursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey as Record<string, unknown>)
    : undefined;
  return { items, nextCursor };
}

/**
 * teamLoginKey が response 上で消えていることを test 経路で固定する helper。
 * `assertTeamLoginKeyHidden(detail)` が throw すれば security regression。
 *
 * 本 file 内では `redactTeams` で必ず undefined に潰してから return する。
 */
export function redactTeams(teams: readonly TeamSummary[]): readonly TeamSummary[] {
  return teams.map((t) => ({
    teamId: t.teamId,
    internalSlug: t.internalSlug,
    displayName: t.displayName,
    awsAccountId: t.awsAccountId,
    // teamLoginKey は **常に undefined**。System Admin 経路では一切露出しない。
    teamLoginKey: undefined,
  }));
}

/**
 * 指定 eventId の Event 詳細 + Teams 一覧 + Deployments 集計を返す。
 *
 * `tenantId` 不一致 / event 不在は `undefined` (= caller が 404 を返す)。
 *
 * application-admin-console 経路 (`getEventDetail`) との差分:
 *   - teams[].teamLoginKey を `undefined` に潰す (= System Admin に短命 bearer を渡さない)。
 *   - displayTeamName を Deployments から補完する logic は同じ (= participant が PATCH した
 *     表示名を operator 経路の teams[].displayName に乗せる)。
 */
export async function getEventDetailForTenant(
  shared: AdminInsightSharedResources,
  tenantId: string,
  eventId: string,
): Promise<EventDetail | undefined> {
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
        // problemId / jobId / status / teamId だけ pull。teamLoginKey は projection に
        // 含めない (= 念のため payload 自体にも乗らないようにする)。
        ProjectionExpression: "teamId, eventId, displayTeamName, problemId, jobId, #s",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    ),
  ]);

  const event = eventOut.Item as Record<string, unknown> | undefined;
  if (!event) return undefined;
  if (event.tenantId !== tenantId) return undefined;

  const teamItems = (teamsOut.Items ?? []) as Record<string, unknown>[];

  // teamId → displayTeamName lookup (Deployments 由来。participant が PATCH した値)。
  const displayNameByTeamId = new Map<string, string>();
  const deploymentsByProblem: Record<string, EventDeploymentSummary[]> = {};
  for (const d of deploymentsOut.Items ?? []) {
    const row = d as Record<string, unknown>;
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

  const teamsRaw: TeamSummary[] = teamItems.map((t) => {
    const teamId = String(t.teamId ?? "");
    const fromTeamsTable = typeof t.displayName === "string" ? t.displayName : undefined;
    return {
      teamId,
      internalSlug: String(t.internalSlug ?? ""),
      displayName: displayNameByTeamId.get(teamId) ?? fromTeamsTable,
      awsAccountId: typeof t.awsAccountId === "string" ? t.awsAccountId : undefined,
      // teamLoginKey は **読まない**。redactTeams で念押しで undefined に潰す。
    };
  });
  const teams = redactTeams(teamsRaw);

  const summary = toEventSummary(event);
  const problems = Array.isArray(event.problems)
    ? (event.problems as readonly EventProblemTarget[])
    : [];
  return {
    ...summary,
    problems,
    teams,
    deploymentsByProblem,
  };
}
