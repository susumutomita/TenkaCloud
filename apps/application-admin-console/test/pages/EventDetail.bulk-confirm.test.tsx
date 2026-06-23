/**
 * Issue #1350: Bulk teardown は 「DELETE」 と入力させない限り confirm button が disabled。
 *
 * undo 不可な destructive 操作なので、 誤クリックでの bulkTeardownEvent 発火を防ぐ。
 * 同時に blast radius (= 何 team × 何 problem の削除か) を Alert で明示する。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  bulkTeardownEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    getEvent: mocks.getEvent,
    bulkTeardownEvent: mocks.bulkTeardownEvent,
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
  name: "Bulk Confirm Test Event",
  status: "ENDED",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [
    { teamId: "t1", internalSlug: "team-alpha", awsAccountId: "111111111111" },
    { teamId: "t2", internalSlug: "team-beta", awsAccountId: "222222222222" },
  ],
  problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
};

const { EventDetailPage } = await import("../../src/pages/EventDetail");
const { I18nProvider } = await import("../../src/i18n");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
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
  mocks.bulkTeardownEvent.mockResolvedValue({
    eventId: EVENT_ID,
    enqueued: 2,
    skipped: 0,
  });
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetail bulk teardown confirm dialog #1350", () => {
  it("should show the blast radius alert with team / problem counts", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    // blast radius (= 2 team × 1 problem) の文字列を含む
    await waitFor(() => {
      expect(screen.getByText(/影響範囲/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 team × 1/)).toBeInTheDocument();
  });

  it("should keep the confirm button disabled until DELETE is typed", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    const confirm = await screen.findByTestId("modal-teardown-confirm");
    expect(confirm).toBeDisabled();
    // Cloudscape Input は data-testid を wrapper に付ける。 実 <input> は placeholder で探す。
    // fireEvent.change で一発書き換え (= userEvent.type は character ごとに re-render するので
    // 並列 vitest 下では timeout に乗りやすい)。
    const input = await screen.findByPlaceholderText("DELETE");
    fireEvent.change(input, { target: { value: "delete-wrong" } });
    // wrong text → still disabled
    expect(confirm).toBeDisabled();
  });

  it("should enable the confirm button once DELETE is typed", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    const input = await screen.findByPlaceholderText("DELETE");
    fireEvent.change(input, { target: { value: "DELETE" } });
    const confirm = screen.getByTestId("modal-teardown-confirm");
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });
});
