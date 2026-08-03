import type {
  DeploymentsQueryPort,
  DeploymentsScoringPort,
} from "../../control-data/deployments-repository.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import {
  type PublicScoreEventView,
  type ScoreEventItem,
  toPublicScoreEventView,
} from "../shared/score-event.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * Issue #1038 P1 #6: 全チームの累計スコア推移を 1 endpoint で返す (= participant-portal の
 * ScoreTimelineChart を multi-series に拡張するための data source)。
 *
 * 旧来 `/portal/me/score-events` は自チームのみ。 競技中に rival の伸び方が見えないと
 * 「勝負感」 が薄れるため (= user feedback「自チームだけじゃなくてライバルチームのスコアが
 * みえないと面白くないでしょう」)、 同 event の全 team の event timeline を一括返却する。
 *
 * 公開する field:
 *   - teamId (= ULID、 推測困難)
 *   - teamName (= displayTeamName ?? operator slug)
 *   - isMyTeam (= UI ハイライト用)
 *   - events[] (= occurredAt 昇順、 1 team 最大 200 件)
 *
 * 出さない field:
 *   - teamLoginKey / tenantId / awsAccountId / expiresAt / 内部 PK/SK
 *   (= 公開 shape に存在しないので構造的に漏洩しない)
 *
 * [#2866] 1 event の view shape と mapping (許可 source / result の集合含む) は
 * operator 側 `event-handler/team-score-events.ts` と共通なので
 * `shared/score-event.ts` の {@link PublicScoreEventView} /
 * `toPublicScoreEventView` に 1 本化した。
 */
export type TeamScoreEventView = PublicScoreEventView;

export interface TeamScoreEvents {
  readonly teamId: string;
  readonly teamName: string;
  readonly isMyTeam: boolean;
  /** occurredAt 昇順 (= chart の cumulative 算出に向く順序)。 */
  readonly events: readonly TeamScoreEventView[];
}

export interface LeaderboardScoreEventsResponse {
  readonly eventId: string;
  readonly teams: readonly TeamScoreEvents[];
}

export type LeaderboardScoreEventsOutcome =
  | { kind: "ok"; response: LeaderboardScoreEventsResponse }
  | { kind: "unauthorized" }
  | { kind: "no_event" };

/** 各 team 最大 event 数。 chart に十分 + 1 request の DDB 読み出し量を bound。 */
const PER_TEAM_LIMIT = 200;
/** 1 deployment あたりの page 上限 (= attack-detected が詰まっても scoring 行を回収)。 */
const MAX_PAGES_PER_DEPLOYMENT = 3;

/**
 * teamLoginKey で requester の event を特定し、 同 event 内の全 team の score event timeline を返す。
 *
 * 流れ:
 *   1. GSI2 (TEAMKEY#) で requester 行 → tenantId / eventId / 自 teamId
 *   2. GSI1 (TENANT#) + eventId filter で 同 event の全 deployment を回収
 *   3. teamId 単位に group + teamName / deployment jobId 集合を構築
 *   4. 各 (team, deployment) を Promise.all で並列 query (PK + begins_with EVENT#)
 *   5. team 単位で events を occurredAt 昇順 sort + cap、 累計 score 降順で team 並べ替え
 *
 * 計算量: N teams × M deployments per team × 1〜3 page Query。 MVP 規模 (= teams ~10、
 * deployments per team ~5) で 1 request 約 50〜150 query。30s polling は frontend 側で
 * default off にし、ここでも score activity が無い deployment の EVENT# query を省く。
 */
export async function getLeaderboardScoreEvents(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<LeaderboardScoreEventsOutcome> {
  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  const sample = myItems.find((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status);
  });
  if (!sample) return { kind: "unauthorized" };

  const tenantId = typeof sample.tenantId === "string" ? sample.tenantId : undefined;
  const eventId = typeof sample.eventId === "string" ? sample.eventId : undefined;
  const myTeamId = typeof sample.teamId === "string" ? sample.teamId : undefined;
  if (!tenantId || !eventId || !myTeamId) {
    // Phase 1 以前の旧 jobId-based deployment は eventId/teamId を持たないため event scope
    // で chart を組めない。 leaderboard.ts と同じ shape で 404 化する。
    return { kind: "no_event" };
  }

  // #1797/#1815: pre-seam this endpoint read one GSI1 page only. The repository
  // method owns the full drain, matching leaderboard/event-handler correctness.
  const deploymentsRepository: DeploymentsQueryPort & DeploymentsScoringPort =
    await resolveDeploymentsRepository(shared);
  const eventDeployments = (await deploymentsRepository.listByTenantAndEvent(
    tenantId,
    eventId,
  )) as Partial<DeploymentItem>[];

  const teamMeta = groupDeploymentsByTeam(eventDeployments);

  const teamsResult: TeamScoreEvents[] = await Promise.all(
    [...teamMeta.entries()].map(async ([teamId, meta]) => {
      const collected = await collectTeamEvents(shared, meta.deploymentJobIds);
      collected.sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
      );
      return {
        teamId,
        teamName: meta.teamName,
        isMyTeam: teamId === myTeamId,
        events: collected.slice(0, PER_TEAM_LIMIT),
      };
    }),
  );

  // 累計 score 降順 (= leaderboard と同じ並び)。 同点は teamName 昇順で安定 sort。
  teamsResult.sort((a, b) => {
    const aSum = a.events.reduce((s, e) => s + e.points, 0);
    const bSum = b.events.reduce((s, e) => s + e.points, 0);
    if (bSum !== aSum) return bSum - aSum;
    return a.teamName.localeCompare(b.teamName);
  });

  return { kind: "ok", response: { eventId, teams: teamsResult } };
}

interface TeamMetaEntry {
  teamName: string;
  deploymentJobIds: string[];
}

/** Deployments を teamId 単位に group。 displayTeamName / slug の優先順位は leaderboard と同じ。 */
function groupDeploymentsByTeam(
  items: readonly Partial<DeploymentItem>[],
): Map<string, TeamMetaEntry> {
  const teamMeta = new Map<string, TeamMetaEntry>();
  for (const item of items) {
    addItemToTeamMeta(teamMeta, item);
  }
  return teamMeta;
}

/** 1 deployment 行を team bucket に取り込む (= groupDeploymentsByTeam の per-item helper)。 */
function addItemToTeamMeta(teamMeta: Map<string, TeamMetaEntry>, item: Partial<DeploymentItem>) {
  if (typeof item.teamId !== "string") return;
  if (typeof item.jobId !== "string") return;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return;
  if (!hasScoreTimelineActivity(item)) return;
  const display = typeof item.displayTeamName === "string" ? item.displayTeamName : undefined;
  const slug = typeof item.teamName === "string" ? item.teamName : "";
  const teamName = display ?? slug;
  let m = teamMeta.get(item.teamId);
  if (!m) {
    m = { teamName, deploymentJobIds: [] };
    teamMeta.set(item.teamId, m);
  } else if (display && m.teamName !== display) {
    m.teamName = display;
  }
  m.deploymentJobIds.push(item.jobId);
}

/**
 * Deployment の META 行だけで EVENT# rows の存在可能性を判定し、明らかな idle row は
 * 読まない。旧 row は score が未設定のことがあるため activity ありとして扱い、履歴欠落を避ける。
 */
function hasScoreTimelineActivity(item: Partial<DeploymentItem>): boolean {
  if (typeof item.score !== "number" || !Number.isFinite(item.score)) return true;
  if (item.score !== 0) return true;
  if (typeof item.lastScoredAt === "string" && item.lastScoredAt.length > 0) return true;
  if (item.flagSubmitted === true) return true;
  if (item.solvedFlagIds instanceof Set && item.solvedFlagIds.size > 0) return true;
  if (Array.isArray(item.hintsRevealed) && item.hintsRevealed.length > 0) return true;
  if (typeof item.wrongAnswerCount === "number" && item.wrongAnswerCount > 0) return true;
  return false;
}

/** 1 team の全 deployment jobId について EVENT# rows を回収。 page 上限まで読む。 */
async function collectTeamEvents(
  shared: ParticipantSharedResources,
  deploymentJobIds: readonly string[],
): Promise<TeamScoreEventView[]> {
  const collected: TeamScoreEventView[] = [];
  const deployments: DeploymentsQueryPort & DeploymentsScoringPort =
    await resolveDeploymentsRepository(shared);
  await Promise.all(
    deploymentJobIds.map(async (jobId) => {
      const rows = await deployments.listScoreEvents(jobId, {
        pageSize: PER_TEAM_LIMIT,
        maxPages: MAX_PAGES_PER_DEPLOYMENT,
      });
      for (const it of rows as Partial<ScoreEventItem>[]) {
        const v = toPublicScoreEventView(it);
        if (v) collected.push(v);
      }
    }),
  );
  return collected;
}
