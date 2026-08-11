import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #708: Event teardown が ROLLBACK_COMPLETE な stack で stuck したときの operator rescue。
 * 旧 UX は TEARDOWN になると「削除中... 全削除が完了すると自動で ARCHIVED に遷移します」
 * の Alert だけで、進まない時の脱出経路が無かった。TEARDOWN 時に
 * 「Force ARCHIVED に倒す」 button を出し、 confirm modal 経由で archiveEvent を呼ぶ。
 */

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  archiveEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, getEvent: mocks.getEvent, archiveEvent: mocks.archiveEvent };
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
  name: "Stuck Teardown Event",
  status: "TEARDOWN",
  teamCount: 1,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [{ teamId: "t1", internalSlug: "team-alpha" }],
  problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {
    "hello-world": [{ jobId: "J1", teamId: "t1", status: "DELETING" }],
  },
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
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #708 Force ARCHIVED rescue", () => {
  // #1318: tabs 構造化により Force ARCHIVED は Operations tab に移動。
  // status=TEARDOWN の Event 詳細を開いて Operations tab を選択する helper。
  async function openOperationsTab() {
    // [#2283] gate tab のラベルも "(Advanced)" を含むため、 高度操作 tab は完全一致寄りで判定。
    const opsTab = await screen.findByRole("tab", { name: /^Advanced$|高度操作/ });
    await userEvent.click(opsTab);
  }

  it("should show Force ARCHIVED button + rescue Alert when Event is in TEARDOWN", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Stuck Teardown Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    expect(await screen.findByTestId("force-archive-button")).toBeInTheDocument();
    expect(screen.getByText(/削除が進まない場合/)).toBeInTheDocument();
  });

  it("should NOT show Force ARCHIVED rescue when Event is in DEPLOYING", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "DEPLOYING" });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Stuck Teardown Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    expect(screen.queryByTestId("force-archive-button")).not.toBeInTheDocument();
  });

  it("should call archiveEvent when Force ARCHIVED is confirmed", async () => {
    mocks.getEvent.mockResolvedValue(baseDetail);
    mocks.archiveEvent.mockResolvedValue({ ok: true, archivedAt: "2026-05-13T00:00:00.000Z" });
    renderPage();
    await openOperationsTab();
    const trigger = await screen.findByTestId("force-archive-button");
    await userEvent.click(trigger);
    const confirm = await screen.findByTestId("force-archive-confirm");
    await userEvent.click(confirm);
    await waitFor(() => expect(mocks.archiveEvent).toHaveBeenCalled());
    expect(mocks.archiveEvent).toHaveBeenCalledWith(expect.anything(), EVENT_ID);
  });
});
