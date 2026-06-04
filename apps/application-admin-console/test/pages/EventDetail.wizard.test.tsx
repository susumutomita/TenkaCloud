import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  name: "Test Event",
  status: "DRAFT",
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
  // #1084: locale=ja で既存 JA string assertion を維持
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #531 Wizard", () => {
  it("should display Wizard StepIndicator with 5 labels (create / Deploy / set start time / in competition / end)", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "DRAFT" });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Test Event/).length).toBeGreaterThan(0));
    expect(screen.getByText(/1\. 作成/)).toBeInTheDocument();
    expect(screen.getByText(/2\. Deploy/)).toBeInTheDocument();
    expect(screen.getByText(/3\. 開始時刻設定/)).toBeInTheDocument();
    expect(screen.getByText(/4\. 競技中/)).toBeInTheDocument();
    expect(screen.getByText(/5\. 終了/)).toBeInTheDocument();
  });

  // Overview declutter: 「現在のフェーズ」 だけを残し、 重複していた 「次のアクション」 CTA は削除。
  it("should render only the phase container (the next-action CTA was removed as redundant)", async () => {
    mocks.getEvent.mockResolvedValueOnce({ ...baseDetail, status: "DRAFT" });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Test Event/).length).toBeGreaterThan(0));
    expect(screen.getByText(/現在のフェーズ/)).toBeInTheDocument();
    expect(screen.queryByText(/次のアクション/)).not.toBeInTheDocument();
  });
});
