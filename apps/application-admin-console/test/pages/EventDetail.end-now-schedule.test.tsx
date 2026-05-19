import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  setEventSchedule: vi.fn(),
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
    setEventSchedule: mocks.setEventSchedule,
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
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const NOW_ISO = "2026-05-14T12:00:00.000Z";

const baseDetail: EventDetail = {
  eventId: EVENT_ID,
  name: "Schedule Action Event",
  status: "READY",
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
  vi.spyOn(Date, "now").mockReturnValue(new Date(NOW_ISO).getTime());
  mocks.useApiClient.mockReturnValue({});
  mocks.getEvent.mockResolvedValue(baseDetail);
  mocks.setEventSchedule.mockResolvedValue({ endsAt: NOW_ISO });
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #740 競技スケジュール終了操作", () => {
  it("即座に終了 button で endsAt=now の schedule API を呼ぶべき", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Schedule Action Event/).length).toBeGreaterThan(0),
    );

    await userEvent.click(screen.getByRole("button", { name: "即座に終了" }));

    await waitFor(() => expect(mocks.setEventSchedule).toHaveBeenCalled());
    expect(mocks.setEventSchedule).toHaveBeenCalledWith(expect.anything(), EVENT_ID, {
      endsAt: NOW_ISO,
    });
  });

  it("競技スケジュール section の説明に内部 issue 番号を表示しないべき", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Schedule Action Event/).length).toBeGreaterThan(0),
    );

    expect(screen.queryByText(/#\d{3,}/)).not.toBeInTheDocument();
    expect(screen.getByText(/status は変えずに採点 gate を閉じます/)).toBeInTheDocument();
  });
});
