import { describe, expect, it } from "vitest";
import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../../src/api/portal-client";
import { PortalAuthError } from "../../src/api/portal-client";
import {
  leaderboardIsUnchanged,
  notificationsAreUnchanged,
  toLeaderboardRefreshDecision,
  toPortalMeRefreshDecision,
  viewIsUnchanged,
} from "../../src/auth/team-view-diff";

// biome-ignore lint/suspicious/noExplicitAny: 最小 fixture を組むための緩い型。
const prob = (over: Record<string, any> = {}): any => ({
  jobId: "job-0",
  problemId: "p-0",
  region: "ap-northeast-1",
  awsAccountId: "1",
  status: "COMPLETE",
  stackOutputs: {},
  expiresAt: 0,
  score: 0,
  deployLog: { cursor: "0", entries: [] },
  ...over,
});
const view = (over: Record<string, unknown> = {}): ParticipantTeamView =>
  ({
    team: { teamName: "Blue", teamNameSetByCompetitor: true },
    problems: [prob()],
    ...over,
  }) as ParticipantTeamView;

describe("team-view-diff (Issue #2222)", () => {
  it("should distinguish view / notifications / leaderboard changes independent of the Provider", () => {
    const a = view();
    const b = view({ problems: [prob({ status: "FAILED" }) as ParticipantProblemView] });
    expect(viewIsUnchanged(a, a)).toBe(true);
    expect(viewIsUnchanged(a, b)).toBe(false);
    expect(viewIsUnchanged(null, a)).toBe(false);

    const n1: NotificationsResponse = { eventId: "e1", items: [] } as NotificationsResponse;
    expect(notificationsAreUnchanged(n1, n1)).toBe(true);
    expect(notificationsAreUnchanged(null, n1)).toBe(false);

    const l1: LeaderboardResponse = { eventId: "e1", entries: [] } as LeaderboardResponse;
    expect(leaderboardIsUnchanged(l1, l1)).toBe(true);
    expect(leaderboardIsUnchanged(null, l1)).toBe(false);
  });

  it("should treat a hint reveal as a change even when score is unchanged", () => {
    // Repro: in local-play a hint reveal moves the penalty into the server's
    // running score, NOT the per-problem `score`, so the old diff (which only
    // watched score / flagSubmitted) discarded the refetch and the revealed
    // content never rendered until a full reload. The whole `scoring` object is
    // compared now, so the revealed flip + content is detected.
    const locked = (over: Record<string, unknown> = {}) =>
      prob({
        score: 0,
        scoring: {
          kind: "flag",
          points: 100,
          flagSubmitted: false,
          hints: [{ id: "h1", penalty: 20, revealed: false }],
        },
        ...over,
      }) as ParticipantProblemView;
    const before = view({ problems: [locked()] });
    const after = view({
      problems: [
        locked({
          scoring: {
            kind: "flag",
            points: 100,
            flagSubmitted: false,
            hints: [{ id: "h1", penalty: 20, revealed: true, content: "secret", revealedAt: "t" }],
          },
        }),
      ],
    });
    expect(viewIsUnchanged(before, after)).toBe(false);
    // Idempotent: identical scoring (incl. revealed hints) is still unchanged.
    expect(viewIsUnchanged(after, after)).toBe(true);
  });

  it("should map settled results to refresh decisions directly", () => {
    expect(toPortalMeRefreshDecision({ status: "fulfilled", value: view() })).toEqual({
      kind: "view",
      view: view(),
      stopPolling: false,
    });
    expect(
      toPortalMeRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({ kind: "auth-error" });

    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: undefined })).toEqual({
      kind: "no-event",
    });
    expect(
      toLeaderboardRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({ kind: "auth-error" });
  });
});
