import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTenantEvents: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("../../src/api/admin-drill-down", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/admin-drill-down")>();
  return {
    ...actual,
    fetchTenantEvents: mocks.fetchTenantEvents,
  };
});

vi.mock("../../src/auth/AuthProvider", () => ({
  useAuth: mocks.useAuth,
}));

import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.com",
  cognitoClientId: "client-id",
  redirectUri: "http://localhost/callback",
  apiBaseUrl: "https://control.example.com/",
  scope: "openid",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "https://insight.example.com",
};

const { TenantEventsPage } = await import("../../src/pages/TenantEvents");
const { I18nProvider } = await import("../../src/i18n");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/tenants/t-acme/events"]}>
        <Routes>
          <Route path="/tenants/:tenantId/events" element={<TenantEventsPage config={config} />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Force JA locale for deterministic assertions on i18n strings.
  if (typeof window !== "undefined") {
    window.localStorage.setItem("tenkacloud.admin.locale", "ja");
  }
  mocks.useAuth.mockReturnValue({
    tokens: { idToken: "id-token", accessToken: "a", expiresAt: 0 },
    ready: true,
    login: () => undefined,
    logout: () => undefined,
    setTokens: () => undefined,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("TenantEventsPage (#598 Phase 1.B)", () => {
  it("マウント時に fetchTenantEvents を tenantId 指定で呼ぶべき", async () => {
    mocks.fetchTenantEvents.mockResolvedValueOnce({ items: [] });
    renderPage();
    await waitFor(() => expect(mocks.fetchTenantEvents).toHaveBeenCalled());
    const [, , tenantId] = mocks.fetchTenantEvents.mock.calls[0];
    expect(tenantId).toBe("t-acme");
  });

  it("Event 名 を Link として render すべき", async () => {
    mocks.fetchTenantEvents.mockResolvedValueOnce({
      items: [
        {
          eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
          name: "Sample Event",
          status: "READY",
          teamCount: 3,
          problemCount: 2,
          createdAt: "2026-05-11T00:00:00.000Z",
          updatedAt: "2026-05-11T01:00:00.000Z",
          expiresAt: 0,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Sample Event")).toBeInTheDocument();
  });

  it("403 (forbidden) Alert を表示すべき", async () => {
    const { AdminInsightApiError } = await import("../../src/api/admin-drill-down");
    mocks.fetchTenantEvents.mockRejectedValueOnce(new AdminInsightApiError(403, "forbidden"));
    renderPage();
    expect(await screen.findByText(/権限がありません/)).toBeInTheDocument();
  });

  it('TypeError(`Failed to fetch`) は "テナントを準備中" UI に置き換わるべき (#656)', async () => {
    mocks.fetchTenantEvents.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByText(/テナントを準備中/)).toBeInTheDocument();
    expect(screen.queryByText(/読み込みに失敗しました/)).toBeNull();
  });

  it('502 / 503 / 504 も "テナントを準備中" 扱いになるべき (#656)', async () => {
    const { AdminInsightApiError } = await import("../../src/api/admin-drill-down");
    mocks.fetchTenantEvents.mockRejectedValueOnce(new AdminInsightApiError(503, "unavailable"));
    renderPage();
    expect(await screen.findByText(/テナントを準備中/)).toBeInTheDocument();
  });

  it("500 (= AdminInsight 内部エラー) は従来通り raw error alert になるべき (regression)", async () => {
    const { AdminInsightApiError } = await import("../../src/api/admin-drill-down");
    mocks.fetchTenantEvents.mockRejectedValueOnce(new AdminInsightApiError(500, "boom"));
    renderPage();
    expect(await screen.findByText(/読み込みに失敗しました/)).toBeInTheDocument();
  });
});
