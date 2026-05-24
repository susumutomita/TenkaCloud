import { portalFetch } from "./fetch";
import type { ParticipantTeamView, ScoreEventsResponse } from "./types";

/**
 * Team-scoped endpoints (= 1 teamLoginKey から引ける self view + 自チームの全体集計)。
 *   - getPortalMe: team + N 問題の集約 view
 *   - updateTeamName: 表示用 team 名を patch
 *   - getScoreEvents: 自チームのスコア変動履歴 (時系列降順)
 *
 * 「自チーム全体」 の cross-cut 系を team モジュールに集約。 個別 problem に閉じた
 * call は `problems.ts` / `scoring.ts` 側に置く。
 */

/**
 * `GET /portal/me` を `Authorization: Bearer <teamLoginKey>` で呼び、
 * `ParticipantTeamView` (= team + problems[]) を返す。
 */
export async function getPortalMe(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ParticipantTeamView> {
  return (await portalFetch<ParticipantTeamView>(apiBaseUrl, "portal/me", teamLoginKey, {
    signal,
  })) as ParticipantTeamView;
}

/**
 * 競技者の表示用チーム名を team scope で更新する (`PATCH /portal/me { teamName }`)。
 * 全 deployment 行に伝播する (Lambda 側で並列 Update)。
 */
export async function updateTeamName(
  apiBaseUrl: string,
  teamLoginKey: string,
  teamName: string,
  signal?: AbortSignal,
): Promise<ParticipantTeamView> {
  return (await portalFetch<ParticipantTeamView>(apiBaseUrl, "portal/me", teamLoginKey, {
    method: "PATCH",
    body: { teamName },
    throwOn400: true,
    signal,
  })) as ParticipantTeamView;
}

/**
 * `GET /portal/me/score-events` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * occurredAt 降順で 100 件まで。team の全 deployment 横断で merge 済。
 */
export async function getScoreEvents(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ScoreEventsResponse> {
  return (await portalFetch<ScoreEventsResponse>(
    apiBaseUrl,
    "portal/me/score-events",
    teamLoginKey,
    { signal },
  )) as ScoreEventsResponse;
}
