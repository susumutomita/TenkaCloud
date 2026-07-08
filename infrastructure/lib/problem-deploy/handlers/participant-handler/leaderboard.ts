import type { LeaderboardEntry, LeaderboardResponse } from "@tenkacloud/portal-contracts";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { getEventGate } from "./event-gate.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * Issue #2203: LeaderboardEntry / LeaderboardResponse の定義正本は
 * `@tenkacloud/portal-contracts` に移設 (= SPA portal-client と共有)。 公開可否の設計判断
 * (teamLoginKey / tenantId / awsAccountId は絶対に出さない、 teamId は ULID なので可) と
 * scoreboardFrozen の凍結 window 仕様は contract 側 docblock を参照。
 *
 * freeze 判定 (本 module の実装):
 *   - now < endsAt - freezeMin       → false (= 通常表示)
 *   - endsAt - freezeMin ≤ now < endsAt → **true** (= 凍結中)
 *   - now ≥ endsAt                   → false (= 競技終了、 最終結果公開)
 *   - endsAt 不在                    → false (= freeze 無効)
 */
export type { LeaderboardEntry, LeaderboardResponse } from "@tenkacloud/portal-contracts";

/**
 * `getLeaderboard` の結果。Phase 1 以前の旧 deployment (eventId 無し) は
 * leaderboard 不能なので `no_event` を返して 404 化する。
 */
export type LeaderboardOutcome =
  | { kind: "ok"; response: LeaderboardResponse }
  | { kind: "unauthorized" }
  | { kind: "no_event" };

/**
 * teamLoginKey から requester の team を特定し、同 event 内の全 team の score 集計を返す。
 *
 * 流れ:
 *   1. GSI2 (TEAMKEY#<key>) で requester 行を引く → tenantId / eventId / 自 teamId 取得
 *   2. GSI1 (TENANT#<tenantId>) + FilterExpression で同 event の全 deployment 行を取得
 *   3. teamId 単位で集計 (score 合計 / COMPLETE 数 / 表示名 / 全 problem 数)
 *   4. score 降順 + 同点は teamName 昇順で安定 sort、rank を付与
 *
 * GSI eventually consistent で直近 schedule された startsAt 等の伝播ラグはあるが、
 * leaderboard は順位表示のみなのでズレは許容範囲 (HealthCheck の 1 分周期に同期)。
 */
export async function getLeaderboard(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<LeaderboardOutcome> {
  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  // 自 team の代表値 (= 最初の live 行) から tenantId / eventId / 自 teamId を引く。
  const sample = myItems.find((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status);
  });
  if (!sample) return { kind: "unauthorized" };

  const tenantId = typeof sample.tenantId === "string" ? sample.tenantId : undefined;
  const eventId = typeof sample.eventId === "string" ? sample.eventId : undefined;
  const myTeamId = typeof sample.teamId === "string" ? sample.teamId : undefined;
  if (!tenantId || !eventId || !myTeamId) {
    // Phase 1 以前の旧 jobId-based deployment は eventId / teamId を持たないため
    // event scope の leaderboard を組めない。
    return { kind: "no_event" };
  }

  // tenant の全 deployment を引いて event 内のものだけ。FilterExpression は post-read
  // なので RCU は変わらないが network / Lambda 内処理量を節約。
  // #1815: 全ページ drain しないと TENANT# パーティションが 1MB 超のとき後続ページの team が
  // leaderboard から欠落する (= 順位表に出ない / scores 欠落の公平性 bug)。
  const deploymentsRepository = await resolveDeploymentsRepository(shared);
  const eventDeployments = (await deploymentsRepository.listByTenantAndEvent(
    tenantId,
    eventId,
  )) as Partial<DeploymentItem>[];

  // Issue #1038 P1 #9: scoreboard freeze 判定。 event gate を引いて endsAt を取得し、
  // 終了 N 分前から終了時刻までは順位を隠す (= 競技公平性、 終盤の駆け込み防止)。
  // N は Event 行の `scoreboardFreezeMinutes` で operator が可変設定 (default 30、 0 で無効化)。
  // tenantId は上のガード (行 60) で非空を保証済み。 seam の tenant scope に渡す。
  const gate = await getEventGate(shared, tenantId, eventId);
  const endsAt = gate?.endsAt;
  const freezeMinutes = gate?.scoreboardFreezeMinutes ?? DEFAULT_FREEZE_MINUTES;
  const scoreboardFrozen = isWithinFreezeWindow(endsAt, Date.now(), freezeMinutes);

  return {
    kind: "ok",
    response: {
      eventId,
      entries: scoreboardFrozen
        ? // 凍結中は entries を空配列で返す (= shape は維持、 frontend が「凍結中」 表示)。
          []
        : buildLeaderboardEntries(eventDeployments, myTeamId),
      ...(scoreboardFrozen !== undefined ? { scoreboardFrozen } : {}),
      ...(endsAt ? { endsAt } : {}),
    },
  };
}

/**
 * Issue #1038 P1 #9: scoreboard freeze window 判定。 終了 N 分前から終了時刻まで true。
 *
 *   - endsAt 不在            → false (= freeze 無効)
 *   - N ≤ 0                  → false (= operator が freeze 機能を無効化、 PR follow-up)
 *   - N が不正値              → default にフォールバック (= 安全側)
 *   - now < endsAt - N min   → false (= 通常表示)
 *   - endsAt - N min ≤ now < endsAt → **true** (= 凍結)
 *   - now ≥ endsAt           → false (= 終了済、 最終結果公開)
 */
export const DEFAULT_FREEZE_MINUTES = 30;
const FREEZE_MINUTES_MAX = 180;

/** 入力の妥当性 check。 0 / N>180 / NaN は default にフォールバック。 */
function normalizeFreezeMinutes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FREEZE_MINUTES;
  if (!Number.isFinite(value)) return DEFAULT_FREEZE_MINUTES;
  if (value < 0) return DEFAULT_FREEZE_MINUTES;
  if (value > FREEZE_MINUTES_MAX) return DEFAULT_FREEZE_MINUTES;
  return value;
}

export function isWithinFreezeWindow(
  endsAt: string | undefined,
  nowMs: number,
  freezeMinutes: number | undefined = DEFAULT_FREEZE_MINUTES,
): boolean {
  if (!endsAt) return false;
  const minutes = normalizeFreezeMinutes(freezeMinutes);
  if (minutes <= 0) return false; // operator 無効化
  const endsAtMs = Date.parse(endsAt);
  if (!Number.isFinite(endsAtMs)) return false;
  if (nowMs >= endsAtMs) return false; // 終了済
  const freezeStartMs = endsAtMs - minutes * 60 * 1000;
  return nowMs >= freezeStartMs;
}

/**
 * Deployments を team で group して集計し、score 降順 (同点は teamName 昇順) でソート + rank 付与。
 * `myTeamId` の team を `isMyTeam=true` でマーク。
 *
 * Pure function: caller が予め fetch した items を渡せば leaderboard を組み立てる。
 * テスト容易性のため export。
 */
export function buildLeaderboardEntries(
  items: readonly Partial<DeploymentItem>[],
  myTeamId: string,
): LeaderboardEntry[] {
  const byTeam = new Map<string, Bucket>();

  for (const item of items) {
    addLeaderboardItem(byTeam, item);
  }

  const sorted = [...byTeam.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.teamName.localeCompare(b.teamName);
  });

  return sorted.map((bucket, idx) => ({
    rank: idx + 1,
    teamId: bucket.teamId,
    teamName: bucket.teamName,
    score: bucket.score,
    completedProblems: bucket.completedProblems,
    totalProblems: bucket.totalProblems,
    isMyTeam: bucket.teamId === myTeamId,
  }));
}

type Bucket = {
  teamId: string;
  teamName: string;
  score: number;
  completedProblems: number;
  totalProblems: number;
};

function getLeaderboardBucket(
  byTeam: Map<string, Bucket>,
  teamId: string,
  teamName: string,
): Bucket {
  const existing = byTeam.get(teamId);
  if (existing) return existing;
  const created = { teamId, teamName, score: 0, completedProblems: 0, totalProblems: 0 };
  byTeam.set(teamId, created);
  return created;
}

function addLeaderboardItem(byTeam: Map<string, Bucket>, item: Partial<DeploymentItem>): void {
  if (typeof item.teamId !== "string") return;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return;
  const display = typeof item.displayTeamName === "string" ? item.displayTeamName : undefined;
  const operatorSlug = typeof item.teamName === "string" ? item.teamName : "";
  const bucket = getLeaderboardBucket(byTeam, item.teamId, display ?? operatorSlug);
  if (display && bucket.teamName !== display) {
    // displayTeamName を持つ行が後から見つかったら採用 (= 全行同期されている前提だが防御)
    bucket.teamName = display;
  }
  bucket.totalProblems += 1;
  bucket.score += Number(item.score ?? 0);
  if (status === "COMPLETE") bucket.completedProblems += 1;
}
