import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LeaderboardResponse,
  type NotificationsResponse,
  type ParticipantTeamView,
  PortalAuthError,
} from "../../src/api/portal-client";
import type { AppConfig } from "../../src/config";

/**
 * TeamViewProvider: no-op 検出器 (viewIsUnchanged / leaderboardIsUnchanged /
 * notificationsAreUnchanged) を直接 unit-test し、 provider 本体は renderHook + fake timers で
 * polling (mock seed / backend success / 各 error / auth-error / no-event / no-op / stop-polling /
 * markNotificationsSeen) を網羅する。 client 4 種と hook は mock、 notifications-storage は実物。
 */
const { mockGetMe, mockGetLeaderboard, mockGetNotifications, mockAuth, mockIsMock } = vi.hoisted(
  () => ({
    mockGetMe: vi.fn(),
    mockGetLeaderboard: vi.fn(),
    mockGetNotifications: vi.fn(),
    mockAuth: vi.fn(),
    mockIsMock: vi.fn(),
  }),
);

vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return {
    ...actual,
    getPortalMe: mockGetMe,
    getLeaderboard: mockGetLeaderboard,
    getNotifications: mockGetNotifications,
  };
});
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));

const {
  TeamViewProvider,
  useTeamView,
  viewIsUnchanged,
  leaderboardIsUnchanged,
  notificationsAreUnchanged,
  toPortalMeRefreshDecision,
  toLeaderboardRefreshDecision,
} = await import("../../src/auth/TeamViewProvider");

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
const lbEntry = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  teamId: "t1",
  teamName: "Blue",
  score: 10,
  completedProblems: 1,
  totalProblems: 2,
  isMyTeam: true,
  ...over,
});
const lb = (over: Record<string, unknown> = {}): LeaderboardResponse =>
  ({ eventId: "e1", entries: [lbEntry()], ...over }) as LeaderboardResponse;
const notifs = (over: Record<string, unknown> = {}): NotificationsResponse =>
  ({
    eventId: "e1",
    items: [
      {
        notificationId: "n1",
        title: "T",
        body: "B",
        severity: "info",
        occurredAt: "2026-05-20T00:00:00Z",
      },
    ],
    ...over,
  }) as NotificationsResponse;

describe("refresh decisions", () => {
  it("should return view + polling-stop decision on portal/me success", () => {
    const active = view({ problems: [prob({ status: "COMPLETE" }), prob({ status: "FAILED" })] });
    expect(toPortalMeRefreshDecision({ status: "fulfilled", value: active })).toEqual({
      kind: "view",
      view: active,
      stopPolling: false,
    });
    const terminal = view({ problems: [prob({ status: "FAILED" }), prob({ status: "DELETED" })] });
    expect(toPortalMeRefreshDecision({ status: "fulfilled", value: terminal })).toEqual({
      kind: "view",
      view: terminal,
      stopPolling: true,
    });
  });

  it("should map portal/me auth and generic errors", () => {
    expect(
      toPortalMeRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({ kind: "auth-error" });
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: new Error("boom") })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: "plain" })).toEqual({
      kind: "error",
      message: "plain",
    });
  });

  it("should distinguish no-event from updates on leaderboard success", () => {
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: undefined })).toEqual({
      kind: "no-event",
    });
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: lb() })).toEqual({
      kind: "leaderboard",
      leaderboard: lb(),
    });
  });

  it("should map leaderboard auth and generic errors", () => {
    expect(
      toLeaderboardRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({ kind: "auth-error" });
    expect(
      toLeaderboardRefreshDecision({ status: "rejected", reason: new Error("lb down") }),
    ).toEqual({ kind: "error", message: "lb down" });
  });
});

describe("viewIsUnchanged", () => {
  it("should return false for a null prev", () => {
    expect(viewIsUnchanged(null, view())).toBe(false);
  });

  it("should return true for semantically identical views", () => {
    expect(viewIsUnchanged(view(), view())).toBe(true);
  });

  it("should detect team name and problem-count changes", () => {
    expect(
      viewIsUnchanged(view(), view({ team: { teamName: "Red", teamNameSetByCompetitor: true } })),
    ).toBe(false);
    expect(viewIsUnchanged(view(), view({ problems: [prob(), prob({ jobId: "job-1" })] }))).toBe(
      false,
    );
  });

  it("should detect any per-problem field change", () => {
    const cases = [
      { jobId: "x" },
      { status: "FAILED" },
      { score: 99 },
      { lastScoredAt: "2026-01-01" },
      { lastResult: "ok" },
      { scoring: { kind: "flag", flagSubmitted: true } },
      { failureReason: "boom" },
      { deployLog: { cursor: "9", entries: [] } },
      { stackOutputs: { Url: "https://x" } },
    ];
    for (const diff of cases) {
      expect(viewIsUnchanged(view(), view({ problems: [prob(diff)] }))).toBe(false);
    }
  });

  // ── Issue #2283: Progression Gate の lock / unlock 遷移を polling が拾う ──────
  const progression = (over: Record<string, unknown> = {}) => ({
    gateProblemId: "gate-1",
    gateCompleted: false,
    policy: "required",
    completionBonus: 50,
    lockedProblemIds: ["p-1", "p-2"],
    ...over,
  });

  it("should treat identical progression views as unchanged", () => {
    expect(
      viewIsUnchanged(view({ progression: progression() }), view({ progression: progression() })),
    ).toBe(true);
  });

  it("should detect any progression field change (Issue #2283)", () => {
    const cases = [
      { gateProblemId: "gate-2" },
      { gateCompleted: true },
      { policy: "off" },
      { completionBonus: 0 },
      { lockedProblemIds: ["p-1"] }, // unlock で縮む
      { lockedProblemIds: ["p-1", "p-3"] }, // 同じ長さで中身が違う
      { lockedProblemIds: [] }, // 全解放
    ];
    for (const diff of cases) {
      expect(
        viewIsUnchanged(
          view({ progression: progression() }),
          view({ progression: progression(diff) }),
        ),
      ).toBe(false);
    }
  });

  it("should detect progression appearing or disappearing (= gate config / flag toggle)", () => {
    expect(viewIsUnchanged(view(), view({ progression: progression() }))).toBe(false);
    expect(viewIsUnchanged(view({ progression: progression() }), view())).toBe(false);
    // 両方不在 (= 従来 shape) は unchanged のまま
    expect(viewIsUnchanged(view(), view())).toBe(true);
  });

  it("should detect the stackOutputs refill that follows an unlock (Issue #2283)", () => {
    // unlock 前: locked 問題は stackOutputs 空 / unlock 後: 再取得で outputs が埋まる
    const before = view({
      problems: [prob({ problemId: "p-1", stackOutputs: {} })],
      progression: progression(),
    });
    const after = view({
      problems: [prob({ problemId: "p-1", stackOutputs: { Url: "https://unlocked" } })],
      progression: progression({ gateCompleted: true, lockedProblemIds: [] }),
    });
    expect(viewIsUnchanged(before, after)).toBe(false);
  });
});

describe("leaderboardIsUnchanged", () => {
  it("should return false for null prev / eventId / length changes and missing entries", () => {
    expect(leaderboardIsUnchanged(null, lb())).toBe(false);
    expect(leaderboardIsUnchanged(lb(), lb({ eventId: "e2" }))).toBe(false);
    expect(
      leaderboardIsUnchanged(lb(), lb({ entries: [lbEntry(), lbEntry({ teamId: "t2" })] })),
    ).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: sparse entry で !a||!b を踏む。
    expect(leaderboardIsUnchanged({ eventId: "e1", entries: [undefined as any] }, lb())).toBe(
      false,
    );
  });

  it("should return true for identical leaderboards", () => {
    expect(leaderboardIsUnchanged(lb(), lb())).toBe(true);
  });

  it("should detect any per-entry field change", () => {
    const cases = [
      { rank: 2 },
      { teamId: "z" },
      { teamName: "Z" },
      { score: 999 },
      { completedProblems: 2 },
      { totalProblems: 3 },
      { isMyTeam: false },
    ];
    for (const diff of cases) {
      expect(leaderboardIsUnchanged(lb(), lb({ entries: [lbEntry(diff)] }))).toBe(false);
    }
  });
});

describe("notificationsAreUnchanged", () => {
  it("should return false for null prev / eventId / length / id changes and missing items", () => {
    expect(notificationsAreUnchanged(null, notifs())).toBe(false);
    expect(notificationsAreUnchanged(notifs(), notifs({ eventId: "e2" }))).toBe(false);
    expect(
      notificationsAreUnchanged(
        notifs(),
        notifs({ items: [{ notificationId: "n1" }, { notificationId: "n2" }] }),
      ),
    ).toBe(false);
    expect(
      notificationsAreUnchanged(notifs(), notifs({ items: [{ notificationId: "different" }] })),
    ).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: sparse item で !a||!b を踏む。
    expect(notificationsAreUnchanged({ eventId: "e1", items: [undefined as any] }, notifs())).toBe(
      false,
    );
  });

  it("should return true for identical notifications", () => {
    expect(notificationsAreUnchanged(notifs(), notifs())).toBe(true);
  });
});

// ── provider polling ─────────────────────────────────────────────────────────
const config = { apiBaseUrl: "https://api.example.com" } as AppConfig;
const logout = vi.fn();
const wrapper = ({ children }: { children: ReactNode }) => (
  <TeamViewProvider config={config}>{children}</TeamViewProvider>
);
const flush = (ms = 1) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  logout.mockClear();
  mockAuth.mockReturnValue({ session: { sessionToken: "tok", eventId: "e1" }, logout });
  mockIsMock.mockReturnValue(false);
  mockGetMe.mockReset().mockResolvedValue(view());
  mockGetLeaderboard.mockReset().mockResolvedValue(lb());
  mockGetNotifications.mockReset().mockResolvedValue(notifs());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TeamViewProvider polling", () => {
  it("should expose safe no-op defaults outside the provider", async () => {
    const { result } = renderHook(() => useTeamView());
    await act(async () => {
      await result.current.refresh();
      result.current.setAutoRefreshEnabled(true);
      result.current.markNotificationsSeen("2026-05-20T00:00:00Z");
    });

    expect(result.current.autoRefreshEnabled).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("should seed dev-mock fixtures without hitting the backend in mock mode", async () => {
    mockIsMock.mockReturnValue(true);
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.view).not.toBeNull();
    expect(result.current.leaderboard).not.toBeNull();
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it("should not seed without a session token in mock mode", async () => {
    mockIsMock.mockReturnValue(true);
    mockAuth.mockReturnValue({ session: null, logout });
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.view).toBeNull();
  });

  it("should populate view / leaderboard / notifications on a successful backend tick", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.view).toEqual(view());
    expect(result.current.leaderboard).toEqual(lb());
    expect(result.current.notifications).toEqual(notifs());
    expect(result.current.unreadNotificationCount).toBe(1); // no lastSeenAt yet
  });

  it("should not run the 30s status polling by default", async () => {
    renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);

    await flush(30_000);
    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);
  });

  it("should run the 30s status polling only after auto refresh is enabled", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();

    act(() => result.current.setAutoRefreshEnabled(true));
    await flush(30_000);

    expect(result.current.autoRefreshEnabled).toBe(true);
    expect(mockGetMe).toHaveBeenCalledTimes(2);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(2);
  });

  it("should share an in-flight status refresh instead of issuing duplicate reads", async () => {
    let resolveMe: (value: ParticipantTeamView) => void = () => undefined;
    let resolveLeaderboard: (value: LeaderboardResponse) => void = () => undefined;
    mockGetMe.mockReturnValue(new Promise((resolve) => (resolveMe = resolve)));
    mockGetLeaderboard.mockReturnValue(new Promise((resolve) => (resolveLeaderboard = resolve)));

    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();

    expect(result.current.isRefreshing).toBe(true);
    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.refresh();
      void result.current.refresh();
    });

    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMe(view());
      resolveLeaderboard(lb());
    });
    await flush();

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.view).toEqual(view());
    expect(result.current.leaderboard).toEqual(lb());
  });

  it("should keep the same references on an unchanged second tick", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    const firstView = result.current.view;
    await act(async () => void (await result.current.refresh()));
    expect(result.current.view).toBe(firstView); // viewIsUnchanged → setView(prev)
  });

  it("should set an error on a generic portal/me failure but still apply the leaderboard", async () => {
    mockGetMe.mockRejectedValue(new Error("me down"));
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.error).toBe("me down");
    expect(result.current.leaderboard).toEqual(lb());
  });

  it("should log out and skip the leaderboard on a portal/me auth error", async () => {
    mockGetMe.mockRejectedValue(new PortalAuthError());
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(logout).toHaveBeenCalled();
    expect(result.current.leaderboard).toBeNull();
  });

  it("should flag no-event when the leaderboard 404s", async () => {
    mockGetLeaderboard.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.leaderboardNoEvent).toBe(true);
    expect(result.current.leaderboard).toBeNull();
  });

  it("should set a leaderboard error on a generic leaderboard failure", async () => {
    mockGetLeaderboard.mockRejectedValue(new Error("lb down"));
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.leaderboardError).toBe("lb down");
  });

  it("should silently ignore a leaderboard auth error", async () => {
    mockGetLeaderboard.mockRejectedValue(new PortalAuthError());
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.leaderboardError).toBeNull();
    expect(result.current.leaderboard).toBeNull();
  });

  it("should flag notifications no-event on a 404", async () => {
    mockGetNotifications.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.notificationsNoEvent).toBe(true);
  });

  it("should set a notifications error on a generic failure", async () => {
    mockGetNotifications.mockRejectedValue(new Error("notif down"));
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.notificationsError).toBe("notif down");
  });

  it("should log out on a notifications auth error", async () => {
    mockGetNotifications.mockRejectedValue(new PortalAuthError());
    renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(logout).toHaveBeenCalled();
  });

  it("should keep the same notifications reference on an unchanged 60s tick", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    const firstNotifs = result.current.notifications;
    await flush(60_000); // 60s notifications tick, same data
    expect(result.current.notifications).toBe(firstNotifs);
  });

  it("should stop the 30s polling once every problem is terminal", async () => {
    mockGetMe.mockResolvedValue(view({ problems: [prob({ status: "FAILED" })] }));
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    act(() => result.current.setAutoRefreshEnabled(true));
    expect(mockGetMe).toHaveBeenCalledTimes(1);
    await flush(30_000); // next tick must be skipped (stopPollingRef)
    expect(mockGetMe).toHaveBeenCalledTimes(1);
  });

  it("should mark notifications seen and zero the unread badge", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.unreadNotificationCount).toBe(1);
    act(() => result.current.markNotificationsSeen("2026-05-20T00:00:00Z"));
    expect(result.current.unreadNotificationCount).toBe(0);
    // 同値 / 過去は巻き戻さない (no-op)
    act(() => result.current.markNotificationsSeen("2020-01-01T00:00:00Z"));
    expect(result.current.unreadNotificationCount).toBe(0);
  });

  it("should ignore markNotificationsSeen with an empty occurredAt", async () => {
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    act(() => result.current.markNotificationsSeen(""));
    expect(result.current.unreadNotificationCount).toBe(1); // unchanged
  });

  it("should ignore markNotificationsSeen when the session has no eventId", async () => {
    mockAuth.mockReturnValue({ session: { sessionToken: "tok" }, logout });
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    act(() => result.current.markNotificationsSeen("2026-05-20T00:00:00Z"));
    expect(result.current.unreadNotificationCount).toBe(1); // no eventId key → no-op
  });

  it("should no-op refresh in mock mode (and expose default no-ops without a provider)", async () => {
    // default Context (provider 無し) の no-op refresh / markNotificationsSeen を踏む。
    const { result: bare } = renderHook(() => useTeamView());
    await act(async () => void (await bare.current.refresh()));
    act(() => bare.current.markNotificationsSeen("x"));
    expect(bare.current.view).toBeNull();

    // mock mode で exposed refresh() を呼ぶと guard で即 return (backend を叩かない)。
    mockIsMock.mockReturnValue(true);
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    mockGetMe.mockClear();
    await act(async () => void (await result.current.refresh()));
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it("should stringify a non-Error notifications rejection", async () => {
    mockGetNotifications.mockRejectedValue("notif string failure");
    const { result } = renderHook(() => useTeamView(), { wrapper });
    await flush();
    expect(result.current.notificationsError).toBe("notif string failure");
  });
});
