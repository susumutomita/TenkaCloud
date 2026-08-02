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

  it("should treat an on-demand container transition as a change (Issue #2845)", () => {
    // Repro: Start returns 202 and the refetch that follows differs *only* in
    // `lifecycle.status` (stopped → starting). The old diff never looked at
    // `lifecycle`, so setView kept the previous object, the panel never rendered
    // "starting", the 1 秒 lifecycle poll (gated on that status) never enabled, and
    // the 30 秒 auto refresh is opt-in / default off — nothing ever re-checked.
    // 参加者からは 「起動を押しても無反応」 に見え、 2 回目で stackOutputs (= 比較対象)
    // が埋まって初めて画面が動いていた。
    const withLifecycle = (lifecycle: Record<string, unknown>) =>
      view({ problems: [prob({ lifecycle }) as ParticipantProblemView] });

    expect(
      viewIsUnchanged(withLifecycle({ status: "stopped" }), withLifecycle({ status: "starting" })),
    ).toBe(false);
    expect(
      viewIsUnchanged(withLifecycle({ status: "starting" }), withLifecycle({ status: "running" })),
    ).toBe(false);
    // status が動かない差分 (非同期 start の失敗理由 / 後片付け要求) も拾う。
    expect(
      viewIsUnchanged(
        withLifecycle({ status: "error" }),
        withLifecycle({ status: "error", lastError: "compose build failed" }),
      ),
    ).toBe(false);
    expect(
      viewIsUnchanged(
        withLifecycle({ status: "error" }),
        withLifecycle({ status: "error", cleanupRequired: true }),
      ),
    ).toBe(false);
    // Idempotent: 同一 lifecycle は従来どおり 「変化なし」。
    expect(
      viewIsUnchanged(withLifecycle({ status: "running" }), withLifecycle({ status: "running" })),
    ).toBe(true);
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
