import type { DeploymentsQueryPort } from "../../control-data/deployments-repository.js";
import { parseProgressionGate } from "../shared/progression-gate.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveEventRepositories,
} from "./shared.js";
import { collectTeamScoreEvents, type DeploymentRefForScoreEvents } from "./team-score-events.js";
import type {
  EventDeploymentSummary,
  EventDetail,
  EventItem,
  EventSummary,
  TeamSummary,
} from "./types.js";

const DEPLOYMENT_STATUS_VALUES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
  "DELETING",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
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
    teardownAt: typeof item.teardownAt === "string" ? item.teardownAt : undefined,
    // deployAt も summary に載せる。 backend は schedule で永続化するが、
    // ここに無いと GET /events(/:id) が返さず UI が常に「未設定」になる (teardownAt の取りこぼし対)。
    deployAt: typeof item.deployAt === "string" ? item.deployAt : undefined,
    scoringLocked: item.scoringLocked === true ? true : undefined,
    scoringLockedAt: typeof item.scoringLockedAt === "string" ? item.scoringLockedAt : undefined,
    scoreboardFreezeMinutes:
      typeof item.scoreboardFreezeMinutes === "number" ? item.scoreboardFreezeMinutes : undefined,
  };
}

/**
 * 指定 tenant の Event 一覧を新しい順に返す (GSI1: TENANT#<tenantId> / createdAt)。
 *
 * [#2438] repository seam 経由 (`repositories.events.listEventsPage`)。
 * default backend (dynamodb) では同じ Query + cursor codec (allowlist PK/SK/GSI1PK/GSI1SK)
 * を発火するので、 流通中の cursor 互換 / CFn 差分は無い (byte 互換)。
 */
export async function listEvents(
  shared: EventSharedResources,
  req: ListEventsRequest,
): Promise<ListEventsResponse> {
  const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const repositories = await resolveEventRepositories(shared);
  const { events, nextCursor } = await repositories.events.listEventsPage(req.tenantId, {
    limit,
    cursor: req.cursor,
  });
  const items = events.map((event) => toSummary(event));
  return { items, nextCursor };
}

/**
 * 指定 eventId の Event 詳細 + Teams 一覧を返す。`tenantId` 不一致は undefined (404 相当)。
 *
 * teams[].teamLoginKey is absent by default. An authorized route can opt in with
 * `withTeamLoginKeys`; authorization stays at the HTTP boundary rather than in
 * this repository projection helper.
 *
 * Issue #1038 P1 #7: `opts.withScoreEvents=true` のとき全 team の累計 score event timeline を
 * `scoreEventsByTeam` に含める。 default (= false) は従来挙動を維持 (= 余分な DDB query を
 * 発生させない、 既存 caller への影響なし)。
 */
export async function getEventDetail(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  opts: {
    readonly withScoreEvents?: boolean;
    readonly withTeamLoginKeys?: boolean;
  } = {},
): Promise<EventDetail | undefined> {
  // Event 行の point read も Teams 一覧も repository seam 経由 (getEvent が
  // tenant scope + 404 判定を、 listTeamsByEvent が base-table query を担う)。 default backend
  // = dynamodb なので発火する GetCommand / QueryCommand は従来と byte 互換 (= 同 table / 同 Key
  // / 同 KeyConditionExpression / 同 client)、 CFn 差分 0。 CONTROL_DATA_BACKEND を turso に
  // 切替えると同 read が SQLite に向く (適用は @libsql adapter 配線後)。 listTeamsByEvent は
  // teamId 昇順で TeamRecord[] (物理キー無し) を返すが、 下流は teamId / internalSlug /
  // displayName / awsAccountId の非機密 field だけを projection する。
  // Event Get と Teams / Deployments Query は依存関係なし → 並列発火でラウンドトリップを節約。
  // Deployments は競技者が PATCH /portal/me で設定した displayTeamName を引くため必要
  // (TeamsTable には participant が直接書けないので displayName が常に空のままになる、
  // という統合ギャップへの補正)。GSI1 = TENANT#<tenantId> 全件取得 →
  // eventId で in-memory filter。
  const repositories = await resolveEventRepositories(shared);
  const deploymentsRepository: DeploymentsQueryPort = await resolveDeploymentsRepository(shared);
  const [event, teamRecords, deploymentsOut] = await Promise.all([
    repositories.events.getEvent(tenantId, eventId),
    repositories.teams.listTeamsByEvent(eventId),
    deploymentsRepository.listDeploymentSummariesByTenant(tenantId),
  ]);
  // getEvent は tenant 不一致 / 不在をどちらも undefined に畳んでいる (= 従来の
  // `!event || event.tenantId !== tenantId` を repository 内へ移設)。
  if (!event) return undefined;

  const { displayNameByTeamId, deploymentsByProblem, deploymentRefs } =
    aggregateDeploymentsForEvent(deploymentsOut as readonly Record<string, unknown>[], eventId);

  const teams: TeamSummary[] = teamRecords.map((t) => {
    const teamId = String(t.teamId ?? "");
    const fromTeamsTable = typeof t.displayName === "string" ? t.displayName : undefined;
    return {
      teamId,
      internalSlug: String(t.internalSlug ?? ""),
      // 競技者が portal で設定した名前 (Deployments 経由) を優先、無ければ
      // TeamsTable.displayName (operator 事前設定があれば)、それも無ければ undefined。
      displayName: displayNameByTeamId.get(teamId) ?? fromTeamsTable,
      // #528: team の deploy 先 AWS Account ID。旧 Event は undefined。
      awsAccountId: typeof t.awsAccountId === "string" ? t.awsAccountId : undefined,
      ...(opts.withTeamLoginKeys && typeof t.teamLoginKey === "string"
        ? { teamLoginKey: t.teamLoginKey }
        : {}),
    };
  });

  const scoreEventsByTeam = opts.withScoreEvents
    ? await collectTeamScoreEvents(shared, {
        deployments: deploymentRefs,
        displayNameByTeamId,
      })
    : undefined;

  const summary = toSummary(event);
  // Issue #2283: 保存済み Gate 設定を detail に載せる (不正 shape は寛容 parse で除外)。
  const progressionGate = parseProgressionGate(event.progressionGate);
  return {
    ...summary,
    problems: Array.isArray(event.problems) ? (event.problems as EventDetail["problems"]) : [],
    teams,
    deploymentsByProblem,
    ...(scoreEventsByTeam !== undefined ? { scoreEventsByTeam } : {}),
    ...(progressionGate !== undefined ? { progressionGate } : {}),
  };
}

/**
 * Deployment rows を 3 つの view (= displayName / deploymentsByProblem / deploymentRefs) に
 * 同時集約する pure helper。 `getEventDetail` の cognitive complexity を抑えるために
 * 切り出した。 同一 row を 3 view に流すので 1 pass で済む。
 */
function aggregateDeploymentsForEvent(
  items: readonly Record<string, unknown>[],
  eventId: string,
): {
  displayNameByTeamId: Map<string, string>;
  deploymentsByProblem: Record<string, EventDeploymentSummary[]>;
  deploymentRefs: DeploymentRefForScoreEvents[];
} {
  const displayNameByTeamId = new Map<string, string>();
  const deploymentsByProblem: Record<string, EventDeploymentSummary[]> = {};
  const deploymentRefs: DeploymentRefForScoreEvents[] = [];
  for (const d of items) {
    if (d.eventId !== eventId) continue;
    captureDisplayName(d, displayNameByTeamId);
    captureDeploymentRef(d, deploymentRefs);
    captureDeploymentSummary(d, deploymentsByProblem);
  }
  return { displayNameByTeamId, deploymentsByProblem, deploymentRefs };
}

function captureDisplayName(d: Record<string, unknown>, byTeamId: Map<string, string>): void {
  if (typeof d.teamId !== "string") return;
  if (typeof d.displayTeamName !== "string") return;
  if (d.displayTeamName.length === 0) return;
  byTeamId.set(d.teamId, d.displayTeamName);
}

function captureDeploymentRef(
  d: Record<string, unknown>,
  refs: DeploymentRefForScoreEvents[],
): void {
  if (typeof d.jobId !== "string") return;
  if (typeof d.teamId !== "string") return;
  refs.push({
    jobId: d.jobId,
    teamId: d.teamId,
    teamName: typeof d.teamName === "string" ? d.teamName : undefined,
  });
}

function captureDeploymentSummary(
  d: Record<string, unknown>,
  byProblem: Record<string, EventDeploymentSummary[]>,
): void {
  if (typeof d.problemId !== "string") return;
  if (typeof d.jobId !== "string") return;
  if (typeof d.teamId !== "string") return;
  const status = parseDeploymentStatus(d.status);
  if (!status) return;
  const list = byProblem[d.problemId] ?? [];
  list.push({ jobId: d.jobId, teamId: d.teamId, status });
  byProblem[d.problemId] = list;
}
