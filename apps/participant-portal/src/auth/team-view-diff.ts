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
      p.scoring?.flagSubmitted !== n.scoring?.flagSubmitted ||
      p.failureReason !== n.failureReason ||
      p.deployLog?.cursor !== n.deployLog?.cursor ||
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
