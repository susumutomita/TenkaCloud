import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  setEventSchedule: vi.fn(),
  endEvent: vi.fn(),
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
    endEvent: mocks.endEvent,
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

function renderPage(mode?: AppConfig["mode"]) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <Routes>
          <Route
            path="/events/:eventId"
            element={<EventDetailPage config={{ ...config, mode }} />}
          />
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
  mocks.endEvent.mockResolvedValue({ endsAt: NOW_ISO, updatedDeployments: 1 });
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #740 competition schedule end operations", () => {
  // #1318: tabs 構造化により 競技スケジュール section は Schedule tab に移動。
  async function openScheduleTab() {
    const scheduleTab = await screen.findByRole("tab", { name: /Schedule|スケジュール/ });
    fireEvent.click(scheduleTab);
  }

  it.each(["local-host", "cloud-host"] as const)(
    "ends immediately through the server-clock API in %s mode",
    async (mode) => {
      renderPage(mode);
      await openScheduleTab();
      fireEvent.click(await screen.findByRole("button", { name: "即座に終了" }));

      await waitFor(() => expect(mocks.endEvent).toHaveBeenCalledTimes(1));
      expect(mocks.endEvent).toHaveBeenCalledWith(expect.anything(), EVENT_ID);
      expect(mocks.setEventSchedule).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy cloud end-now on the schedule API with READY status and editable scheduling", async () => {
    mocks.setEventSchedule.mockImplementation(async () => {
      mocks.getEvent.mockResolvedValue({ ...baseDetail, status: "READY", endsAt: NOW_ISO });
      return { endsAt: NOW_ISO, updatedDeployments: 1 };
    });
    renderPage();
    await openScheduleTab();
    fireEvent.click(await screen.findByRole("button", { name: "即座に終了" }));

    await waitFor(() => expect(mocks.setEventSchedule).toHaveBeenCalledTimes(1));
    expect(mocks.setEventSchedule).toHaveBeenCalledWith(expect.anything(), EVENT_ID, {
      endsAt: NOW_ISO,
    });
    expect(mocks.endEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.getEvent).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "日時を指定して終了" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "即座に開始" })).toBeEnabled();
  });

  it("preserves legacy cloud schedule editing for an ended event", async () => {
    mocks.getEvent.mockResolvedValue({ ...baseDetail, status: "ENDED", endsAt: NOW_ISO });
    renderPage();
    await openScheduleTab();
    expect(screen.getByRole("button", { name: "日時を指定して終了" })).toBeEnabled();
  });

  it("uses the same end API from the header confirmation", async () => {
    renderPage("local-host");
    fireEvent.click(await screen.findByRole("button", { name: "Event を終了" }));
    fireEvent.click(await screen.findByRole("button", { name: "終了" }));

    await waitFor(() => expect(mocks.endEvent).toHaveBeenCalledTimes(1));
    expect(mocks.endEvent).toHaveBeenCalledWith(expect.anything(), EVENT_ID);
    expect(mocks.setEventSchedule).not.toHaveBeenCalled();
  });

  it("disables local schedule actions after refreshing the ended event", async () => {
    mocks.endEvent.mockImplementation(async () => {
      mocks.getEvent.mockResolvedValue({ ...baseDetail, status: "ENDED", endsAt: NOW_ISO });
      return { endsAt: NOW_ISO, updatedDeployments: 1 };
    });
    renderPage("local-host");
    await openScheduleTab();
    fireEvent.click(await screen.findByRole("button", { name: "即座に終了" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "即座に終了" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "日時を指定して終了" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "即座に開始" })).toBeDisabled();
  });

  it("should NOT show internal issue numbers in the competition schedule section description", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Schedule Action Event/).length).toBeGreaterThan(0),
    );
    await openScheduleTab();

    expect(screen.queryByText(/#\d{3,}/)).not.toBeInTheDocument();
    expect(await screen.findByText(/採点期間を設定します/)).toBeInTheDocument();
  });
});
