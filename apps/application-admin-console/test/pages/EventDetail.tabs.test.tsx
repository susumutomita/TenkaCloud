import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1318: Event Detail 画面を 7 tabs に再編した時の構造テスト。
 *
 * 「温泉宿状態」 (情報過密 で workflow が読めない) 解消を確認する。
 *
 * - 7 tabs (Overview / Schedule / Problems / Teams / Scoreboard / Notifications / Operations) が並ぶ
 * - Overview tab が default で active
 * - tab 切替で Schedule の中身が表示される
 * - URL fragment #tab=problems で初期 tab を選択できる
 * - すべての section (Phase indicator / Force ARCHIVED / 問題セット / 通知 など) が 7 tabs のどこかに残る (情報欠落なし)
 */

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    useApiClient: mocks.useApiClient,
  };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    getEvent: mocks.getEvent,
  };
});

import type { EventDetail } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const baseDetail: EventDetail = {
  eventId: EVENT_ID,
  name: "Tabs Test Event",
  status: "READY",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [
    { teamId: "t1", internalSlug: "team-alpha" },
    { teamId: "t2", internalSlug: "team-beta" },
  ],
  problems: [{ problemId: "hello-world-battle", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
};

const { EventDetailPage } = await import("../../src/pages/EventDetail");
const { I18nProvider } = await import("../../src/i18n");

function renderPage(initialPath = `/events/${EVENT_ID}`) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetailPage config={config} />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  // #1084: locale=ja で既存 JA string assertion を維持
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  // URL hash をリセット (= 各テストが独立)
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #1318 tabs", () => {
  it("should render all 8 workflow tabs", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Tabs Test Event/).length).toBeGreaterThan(0));
    // tab のラベル (button 内のテキスト) が 8 つ揃っていること。
    expect(screen.getByRole("tab", { name: /Overview|概要/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Schedule|スケジュール/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Problems|問題/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Teams|チーム/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Scoreboard|スコア/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Notifications|通知/ })).toBeInTheDocument();
    // gate tab のラベルも "(Advanced)" を含むため、 高度操作 tab は完全一致寄りで判定。
    expect(screen.getByRole("tab", { name: /^Advanced$|高度操作/ })).toBeInTheDocument();
    // [#2283] Progression / Gate (Advanced) tab は feature flag に関係なく常時表示。
    expect(screen.getByRole("tab", { name: /Progression|進行 \/ Gate/ })).toBeInTheDocument();
  });

  it("should render Overview tab content (Phase indicator) by default", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "DRAFT" });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Tabs Test Event/).length).toBeGreaterThan(0));
    // Phase indicator (1. 作成 / 2. Deploy / ...) は Overview tab に出る
    expect(screen.getByText(/1\. 作成/)).toBeInTheDocument();
  });

  it("should switch to Schedule tab when clicked", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Tabs Test Event/).length).toBeGreaterThan(0));
    const user = userEvent.setup();
    const scheduleTab = screen.getByRole("tab", { name: /Schedule|スケジュール/ });
    await user.click(scheduleTab);
    // Schedule tab の中の panel header (= 競技スケジュール) が現れる
    await waitFor(() => {
      expect(screen.getByText(/競技スケジュール/)).toBeInTheDocument();
    });
  });

  it("should accept URL fragment #tab=problems to deep-link to Problems tab", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    // window.location.hash を初期化してから render
    window.history.replaceState(null, "", `${window.location.pathname}#tab=problems`);
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Tabs Test Event/).length).toBeGreaterThan(0));
    // problem set table header が見えていれば Problems tab が active
    await waitFor(() => {
      expect(screen.getByText(/問題セット/)).toBeInTheDocument();
    });
  });

  it("should keep TEARDOWN rescue Force ARCHIVED button accessible (Operations tab)", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "TEARDOWN" });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Tabs Test Event/).length).toBeGreaterThan(0));
    const user = userEvent.setup();
    const opsTab = screen.getByRole("tab", { name: /^Advanced$|高度操作/ });
    await user.click(opsTab);
    // Force ARCHIVED rescue button が Operations tab に残る (= 情報欠落なし)
    await waitFor(() => {
      expect(screen.getByTestId("force-archive-button")).toBeInTheDocument();
    });
  });
});
