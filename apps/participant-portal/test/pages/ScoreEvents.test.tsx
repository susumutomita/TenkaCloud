import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortalAuthError,
  type ScoreEventsResponse,
  type ScoreEventView,
} from "../../src/api/portal-client";
import type { AppConfig } from "../../src/config";

/**
 * ScoreEventsPage (累積スコア LineChart + 履歴 Table) の render 分岐と polling tick の
 * 結果ハンドリング (loading / error / PortalAuthError→logout / 成功 / mock seed / 空) を pin
 * する。 ScoreEventsTable は stub せず実物で render し、 source badge / points 正負 / 空状態を
 * 同時に網羅する。 buildCumulativeSeries の sort・同値・無効 timestamp skip も同経路で踏む。
 */
const { mockAuth, mockIsMock, mockGet, mockTeamViewRefresh, mockUseTeamView } = vi.hoisted(() => {
  const refresh = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockIsMock: vi.fn(),
    mockGet: vi.fn(),
    mockTeamViewRefresh: refresh,
    mockUseTeamView: vi.fn(() => ({ refresh })),
  };
});

vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  useLang: () => "ja",
}));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
// Issue #3184: TopNav の Score / Rank は TeamViewProvider から来る。 このページの
// refresh がそれを引き直しているかが検証対象なので、 provider ごと mock して
// 「呼ばれたか」 を見る。
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockUseTeamView }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return { ...actual, getScoreEvents: mockGet };
});

const { ScoreEventsPage } = await import("../../src/pages/ScoreEvents");

const config = { apiBaseUrl: "https://api.example.com" } as AppConfig;
const logout = vi.fn();
const renderPage = () => render(<ScoreEventsPage config={config} />);

const ev = (over: Partial<ScoreEventView>): ScoreEventView => ({
  jobId: "job-1",
  problemId: "p",
  source: "flag",
  points: 10,
  result: "ok",
  occurredAt: "2026-05-22T13:00:00Z",
  ...over,
});

beforeAll(() => {
  // Cloudscape LineChart は ResizeObserver を使うので jsdom 用に最小 stub を与える。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  mockAuth.mockReturnValue({ session: { sessionToken: "team-key" }, logout });
  mockIsMock.mockReturnValue(false);
  mockGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ScoreEventsPage", () => {
  it("should show the loading spinner before the first tick resolves", () => {
    mockGet.mockReturnValue(new Promise<never>(() => undefined)); // never resolves
    renderPage();
    expect(screen.getByText("app.loading")).toBeInTheDocument();
  });

  it("should surface a fetch error", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    renderPage();
    expect(await screen.findByText("network down")).toBeInTheDocument();
  });

  it("should stringify a non-Error fetch rejection", async () => {
    mockGet.mockRejectedValue("plain failure");
    renderPage();
    expect(await screen.findByText("plain failure")).toBeInTheDocument();
  });

  it("should log out on a PortalAuthError without showing an error alert", async () => {
    mockGet.mockRejectedValue(new PortalAuthError());
    renderPage();
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(screen.queryByText("app.fetch_status_failed")).not.toBeInTheDocument();
  });

  it("should render the cumulative chart and history table for all source/point kinds", async () => {
    mockGet.mockResolvedValue({
      entries: [
        ev({
          problemId: "p-flag",
          source: "flag",
          points: 100,
          occurredAt: "2026-05-22T13:00:00Z",
        }),
        ev({ problemId: "p-up", source: "uptime", points: 60, occurredAt: "2026-05-22T12:00:00Z" }),
        // p-flag と同一 timestamp → sort comparator の === 0 経路。
        ev({
          problemId: "p-wrong",
          source: "flag-wrong",
          points: -10,
          occurredAt: "2026-05-22T13:00:00Z",
        }),
        ev({ problemId: "p-hint", source: "hint", points: -5, occurredAt: "2026-05-22T14:00:00Z" }),
        // 無効 timestamp → buildCumulativeSeries の !Number.isFinite continue。
        // points 負 = uptime ダウン/障害 → reason_uptime_down 経路も兼ねる。
        ev({ problemId: "p-bad", source: "uptime", points: -25, occurredAt: "not-a-date" }),
      ],
    });
    renderPage();
    expect(await screen.findByText("score_events.cumulative_header")).toBeInTheDocument();
    expect(screen.getByText('score_events.history_header|{"count":5}')).toBeInTheDocument();
    // table rows
    expect(screen.getByText("p-flag")).toBeInTheDocument();
    expect(screen.getByText("p-hint")).toBeInTheDocument();
    // source badge: 全 4 種 (uptime は 2 件)
    expect(screen.getByText("score_events.source_flag")).toBeInTheDocument();
    expect(screen.getByText("score_events.source_flag_wrong")).toBeInTheDocument();
    expect(screen.getByText("score_events.source_hint")).toBeInTheDocument();
    expect(screen.getAllByText("score_events.source_uptime")).toHaveLength(2);
    // points 正負の両分岐
    expect(screen.getByText("+100 pt")).toBeInTheDocument();
    expect(screen.getByText("-10 pt")).toBeInTheDocument();
    // 理由 column: source + 符号から導く (= なぜ加点/減点されたか)
    expect(screen.getByText("score_events.reason_flag")).toBeInTheDocument();
    expect(screen.getByText("score_events.reason_flag_wrong")).toBeInTheDocument();
    expect(screen.getByText("score_events.reason_hint")).toBeInTheDocument();
    expect(screen.getByText("score_events.reason_uptime_up")).toBeInTheDocument();
    expect(screen.getByText("score_events.reason_uptime_down")).toBeInTheDocument();
  });

  it("renders the battle gain and floored penalty with their public reasons", async () => {
    mockGet.mockResolvedValue({
      entries: [
        ev({
          source: "coordination",
          points: -30,
          reason: "deadline",
          occurredAt: "2026-05-22T13:01:00Z",
        }),
        ev({ source: "coordination", points: 30, reason: "cipher" }),
        ev({ source: "coordination", points: 0, reason: undefined, problemId: "legacy" }),
      ],
    });
    renderPage();
    expect(await screen.findByText('score_events.history_header|{"count":3}')).toBeInTheDocument();
    expect(screen.getAllByText("score_events.source_coordination")).toHaveLength(3);
    expect(screen.getByText("score_events.coordination_cipher")).toBeInTheDocument();
    expect(screen.getByText("score_events.coordination_deadline")).toBeInTheDocument();
    expect(screen.getByText("score_events.reason_coordination")).toBeInTheDocument();
    expect(screen.getByText("+30 pt")).toBeInTheDocument();
    expect(screen.getByText("-30 pt")).toBeInTheDocument();
    expect(screen.getByText("score_events.cumulative_header")).toBeInTheDocument();
  });

  it("should paginate the history table at 20 rows per page (#履歴多すぎ)", async () => {
    // 25 件 → page 1 に 20 行、 残り 5 行は page 2。 uptime Battle の毎分加点で履歴が膨らむため。
    const entries = Array.from({ length: 25 }, (_, i) =>
      ev({
        problemId: `p-${String(i).padStart(2, "0")}`,
        source: "uptime",
        points: 100,
        occurredAt: `2026-05-22T${String(23 - (i % 24)).padStart(2, "0")}:00:00Z`,
      }),
    );
    mockGet.mockResolvedValue({ entries });
    const { container } = renderPage();
    await screen.findByText('score_events.history_header|{"count":25}');
    // page 1: 20 行 (= 20 個の problemId <code> セル)
    expect(container.querySelectorAll("code")).toHaveLength(20);
    // pagination コントロールが出る
    const next = screen.getByRole("button", { name: "score_events.pagination_next" });
    fireEvent.click(next);
    // page 2: 残り 5 行
    expect(container.querySelectorAll("code")).toHaveLength(5);
  });

  it("should not show pagination when there are 20 or fewer entries", async () => {
    mockGet.mockResolvedValue({
      entries: Array.from({ length: 5 }, (_, i) => ev({ problemId: `q-${i}`, source: "uptime" })),
    });
    const { container } = renderPage();
    await screen.findByText('score_events.history_header|{"count":5}');
    expect(container.querySelectorAll("code")).toHaveLength(5);
    expect(
      screen.queryByRole("button", { name: "score_events.pagination_next" }),
    ).not.toBeInTheDocument();
  });

  it("should render the empty table and no chart when there are no entries", async () => {
    mockGet.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();
    expect(screen.queryByText("score_events.cumulative_header")).not.toBeInTheDocument();
  });

  it("should not refresh every 30s by default", async () => {
    mockGet.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();
    mockGet.mockClear();

    vi.useFakeTimers();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockGet).not.toHaveBeenCalled();
  });

  it("should not issue an interval refresh while the initial score-events fetch is in flight", async () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    renderPage();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    fireEvent.click(screen.getByText(/score_events\.auto_refresh_label/));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("should refresh on demand and only poll after auto refresh is enabled", async () => {
    mockGet.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "score_events.refresh_latest" }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    vi.useFakeTimers();
    fireEvent.click(screen.getByText(/score_events\.auto_refresh_label/));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  /**
   * Issue #3184: live 事象そのもの。 履歴に 「Gate ボーナス +100000 pt」 が並んでいるのに
   * TopNav が加点前の 100 pt で固まり、 「最新の履歴に更新」 を何度押しても動かなかった。
   * 履歴と header は別 source (getScoreEvents / TeamViewProvider) なので、 このボタンは
   * 両方を引き直す必要がある。
   */
  it("should refresh the top-nav Score/Rank as well as the history", async () => {
    mockGet.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();
    expect(mockTeamViewRefresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "score_events.refresh_latest" }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockTeamViewRefresh).toHaveBeenCalledTimes(1);
  });

  it("should keep the top-nav in step while this page auto-refreshes", async () => {
    mockGet.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByText(/score_events\.auto_refresh_label/));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockTeamViewRefresh).toHaveBeenCalledTimes(1);
  });

  it("should share an in-flight refresh instead of issuing duplicate reads", async () => {
    let resolveFetch: (value: ScoreEventsResponse) => void = () => undefined;
    mockGet.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    renderPage();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "score_events.refresh_latest" }));
    fireEvent.click(screen.getByRole("button", { name: "score_events.refresh_latest" }));

    expect(mockGet).toHaveBeenCalledTimes(1);
    resolveFetch({ entries: [] });
    expect(await screen.findByText("score_events.empty_header")).toBeInTheDocument();
  });

  it("should seed dev-mock fixtures without calling the backend in mock mode", async () => {
    mockIsMock.mockReturnValue(true);
    renderPage();
    // 旧クエスト削除後の demo fixture は履歴 0 件 (= 0 pt スタート)。 チャートは出ず
    // 履歴 Container の empty 表示だけが出る。
    expect(await screen.findByText('score_events.history_header|{"count":0}')).toBeInTheDocument();
    expect(screen.queryByText("score_events.cumulative_header")).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("should not poll and stay on the spinner without a session token", () => {
    mockAuth.mockReturnValue({ session: null, logout });
    renderPage();
    expect(screen.getByText("app.loading")).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("should not seed dev-mock fixtures in mock mode without a session token", () => {
    mockIsMock.mockReturnValue(true);
    mockAuth.mockReturnValue({ session: null, logout });
    renderPage();
    // mock mode かつ session 無し → seed されないので chart も table も出ない。
    expect(screen.queryByText("score_events.cumulative_header")).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
