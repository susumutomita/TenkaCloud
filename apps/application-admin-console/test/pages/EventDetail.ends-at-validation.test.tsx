import { render, screen, waitFor, within } from "@testing-library/react";
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
const STARTS_AT = "2026-05-14T10:00:00.000Z";

const baseDetail: EventDetail = {
  eventId: EVENT_ID,
  name: "Schedule Validation Event",
  status: "READY",
  teamCount: 1,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  startsAt: STARTS_AT,
  teams: [{ teamId: "t1", internalSlug: "team-alpha" }],
  problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
};

const { EventDetailPage } = await import("../../src/pages/EventDetail");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
      <Routes>
        <Route path="/events/:eventId" element={<EventDetailPage config={config} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function localDateTimeParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
}

async function openEndsAtModal() {
  renderPage();
  await waitFor(() =>
    expect(screen.getAllByText(/Schedule Validation Event/).length).toBeGreaterThan(0),
  );
  await userEvent.click(screen.getByRole("button", { name: "日時を指定して終了" }));
  return screen.getByRole("dialog", { name: "競技終了日時を指定 (予約)" });
}

async function fillEndsAt(dialog: HTMLElement, iso: string) {
  const { date, time } = localDateTimeParts(iso);
  await userEvent.type(within(dialog).getByPlaceholderText("YYYY/MM/DD"), date);
  await userEvent.type(within(dialog).getByPlaceholderText("hh:mm"), time);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-05-14T00:00:00.000Z").getTime());
  mocks.useApiClient.mockReturnValue({});
  mocks.getEvent.mockResolvedValue(baseDetail);
  mocks.setEventSchedule.mockResolvedValue({ endsAt: "2026-05-14T11:00:00.000Z" });
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #741 終了予約 validation", () => {
  it("開始時刻以前の終了日時なら errorText を出して 設定 button を disabled にすべき", async () => {
    const dialog = await openEndsAtModal();
    await fillEndsAt(dialog, "2026-05-14T09:00:00.000Z");

    expect(
      await within(dialog).findAllByText("終了時刻は開始時刻より後の時刻を指定してください。"),
    ).toHaveLength(2);
    const submit = within(dialog).getByRole("button", { name: "設定" });
    expect(submit).toBeDisabled();
    expect(mocks.setEventSchedule).not.toHaveBeenCalled();
  });

  it("開始時刻より後の終了日時なら 設定 button を有効化して schedule API を呼ぶべき", async () => {
    const dialog = await openEndsAtModal();
    await fillEndsAt(dialog, "2026-05-14T11:00:00.000Z");

    const submit = within(dialog).getByRole("button", { name: "設定" });
    expect(submit).not.toBeDisabled();
    await userEvent.click(submit);

    await waitFor(() => expect(mocks.setEventSchedule).toHaveBeenCalled());
    expect(mocks.setEventSchedule).toHaveBeenCalledWith(expect.anything(), EVENT_ID, {
      endsAt: new Date("2026-05-14T11:00:00.000Z").toISOString(),
    });
  });
});
