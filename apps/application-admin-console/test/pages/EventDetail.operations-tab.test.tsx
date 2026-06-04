import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1328: Event Detail の 「運用」 tab が status が TEARDOWN 以外のときに完全空だった bug。
 *
 * 元仕様 (#1318) は 「普段使わない高度操作」 を 運用 tab に集約するという方針だったが、
 * PR #1324 ではその中身を Force ARCHIVED rescue Alert (= TEARDOWN 専用 conditional) のみ
 * 配置してしまい、 非 TEARDOWN 時の 運用 tab が空 panel になっていた。
 *
 * 本テストは 「status を問わず内容を持つ運用 tab」 を保証する:
 *
 * - DRAFT でも 高度操作 tab に 4 section が見える
 * - EventRescuePanel は引き続き TEARDOWN 時のみ表示 (conditional rescue は維持)
 * - Bulk 再 deploy / teardown danger-zone section は status を問わず表示 (teardown は danger-zone のみ)
 */

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, getEvent: mocks.getEvent };
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
  name: "Operations Tab Test Event",
  status: "DRAFT",
  teamCount: 1,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [{ teamId: "t1", internalSlug: "team-alpha" }],
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
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => vi.restoreAllMocks());

async function openOperationsTab() {
  const opsTab = await screen.findByRole("tab", { name: /Advanced|高度操作/ });
  await userEvent.click(opsTab);
}

describe("EventDetailPage #1328 Operations tab", () => {
  it("should render Operations tab with content even when event is DRAFT", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Operations Tab Test Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    // 運用 tab の説明 Alert (= 高度操作 intro) が見える
    expect(await screen.findByTestId("operations-tab-intro")).toBeInTheDocument();
    // bulk operations / delete container header が見える
    expect(screen.getByTestId("operations-bulk-section")).toBeInTheDocument();
    expect(screen.getByTestId("operations-delete-section")).toBeInTheDocument();
  });

  it("should show EventRescuePanel only when status is TEARDOWN", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "READY" });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Operations Tab Test Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    expect(screen.queryByTestId("force-archive-button")).not.toBeInTheDocument();
    // operations tab は引き続き内容を持つ
    expect(screen.getByTestId("operations-tab-intro")).toBeInTheDocument();
  });

  it("should show the bulk redeploy button regardless of status", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "DRAFT" });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Operations Tab Test Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    // 一括再 deploy のみ (teardown は danger-zone に集約したので本 section には無い)。
    expect(screen.getByTestId("operations-bulk-deploy")).toBeInTheDocument();
    expect(screen.queryByTestId("operations-bulk-teardown")).not.toBeInTheDocument();
  });

  it("should show the teardown danger-zone section regardless of status", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "ENDED" });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Operations Tab Test Event/).length).toBeGreaterThan(0),
    );
    await openOperationsTab();
    expect(screen.getByTestId("operations-delete-button")).toBeInTheDocument();
  });
});
