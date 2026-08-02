import { toErrorMessage } from "@tenkacloud/web-kit";
import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../api/portal-client";
import { PortalAuthError } from "../api/portal-client";

export function viewIsUnchanged(
  prev: ParticipantTeamView | null,
  next: ParticipantTeamView,
): boolean {
  if (!prev) return false;
  if (prev.team.teamName !== next.team.teamName) return false;
  // Issue #2283: `progression` (lock/unlock 遷移) も比較対象。 小さな plain JSON なので
  // stackOutputs 比較と同じく JSON.stringify で全 field を漏れなく比較する (= field 追加時に
  // 黙って取りこぼさない)。 unlock 時は lockedProblemIds 縮小に加え該当 problem の stackOutputs
  // 再充填も起きるが、 後者は下の per-problem JSON 比較が検出する。
  if (JSON.stringify(prev.progression) !== JSON.stringify(next.progression)) return false;
  if (prev.problems.length !== next.problems.length) return false;
  for (let i = 0; i < prev.problems.length; i++) {
    const p = prev.problems[i] as ParticipantProblemView;
    const n = next.problems[i] as ParticipantProblemView;
    if (
      p.jobId !== n.jobId ||
      p.status !== n.status ||
      p.score !== n.score ||
      p.lastScoredAt !== n.lastScoredAt ||
      p.lastResult !== n.lastResult ||
      // scoring 全体を比較する。 flagSubmitted に加え、 hint reveal (revealed / content) や
      // multi-flag の sub-flag solved 遷移も検出する。 local-play では hint penalty が
      // per-problem score に乗らないため score 比較だけでは reveal を取りこぼし、 refetch が
      // 破棄されて 「開いたヒントがリロードするまで出ない」 退行になっていた。
      JSON.stringify(p.scoring) !== JSON.stringify(n.scoring) ||
      p.failureReason !== n.failureReason ||
      p.deployLog?.cursor !== n.deployLog?.cursor ||
      // Issue #2845: local-play の on-demand container 状態も比較対象。 起動直後の refetch は
      // `lifecycle.status` (stopped → starting) しか変わらず、 ここに無いと 「変化なし」 と
      // 判定されて setView が prev を返し、 UI が永久に stopped のままになる。 status だけでなく
      // lastError / cleanupRequired / runtimeKind も拾うため object 全体を比較する。
      JSON.stringify(p.lifecycle) !== JSON.stringify(n.lifecycle) ||
      JSON.stringify(p.stackOutputs) !== JSON.stringify(n.stackOutputs)
    ) {
      return false;
    }
  }
  return true;
}

export function notificationsAreUnchanged(
  prev: NotificationsResponse | null,
  next: NotificationsResponse,
): boolean {
  if (!prev) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.items.length !== next.items.length) return false;
  for (let i = 0; i < prev.items.length; i++) {
    const a = prev.items[i];
    const b = next.items[i];
    if (!a || !b) return false;
    if (a.notificationId !== b.notificationId) return false;
  }
  return true;
}

export function leaderboardIsUnchanged(
  prev: LeaderboardResponse | null,
  next: LeaderboardResponse,
): boolean {
  if (!prev) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.entries.length !== next.entries.length) return false;
  for (let i = 0; i < prev.entries.length; i++) {
    const a = prev.entries[i];
    const b = next.entries[i];
    if (!a || !b) return false;
    if (
      a.rank !== b.rank ||
      a.teamId !== b.teamId ||
      a.teamName !== b.teamName ||
      a.score !== b.score ||
      a.completedProblems !== b.completedProblems ||
      a.totalProblems !== b.totalProblems ||
      a.isMyTeam !== b.isMyTeam
    ) {
      return false;
    }
  }
  return true;
}

export type PortalMeRefreshDecision =
  | { readonly kind: "view"; readonly view: ParticipantTeamView; readonly stopPolling: boolean }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "auth-error" };

export type LeaderboardRefreshDecision =
  | { readonly kind: "leaderboard"; readonly leaderboard: LeaderboardResponse }
  | { readonly kind: "no-event" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "auth-error" };

function shouldStopProblemPolling(view: ParticipantTeamView): boolean {
  return view.problems.every((p) => p.status === "FAILED" || p.status === "DELETED");
}

export function toPortalMeRefreshDecision(
  result: PromiseSettledResult<ParticipantTeamView>,
): PortalMeRefreshDecision {
  if (result.status === "fulfilled") {
    return {
      kind: "view",
      view: result.value,
      stopPolling: shouldStopProblemPolling(result.value),
    };
  }
  if (result.reason instanceof PortalAuthError) return { kind: "auth-error" };
  return { kind: "error", message: toErrorMessage(result.reason) };
}

export function toLeaderboardRefreshDecision(
  result: PromiseSettledResult<LeaderboardResponse | undefined>,
): LeaderboardRefreshDecision {
  if (result.status === "fulfilled") {
    return result.value === undefined
      ? { kind: "no-event" }
      : { kind: "leaderboard", leaderboard: result.value };
  }
  if (result.reason instanceof PortalAuthError) return { kind: "auth-error" };
  return { kind: "error", message: toErrorMessage(result.reason) };
}
