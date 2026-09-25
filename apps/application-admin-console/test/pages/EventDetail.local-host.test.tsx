import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #3226: the normal Event Detail page on the local competition host. Cloud-only tabs and
 * panels are replaced by local equivalents or an explanation, and environments are operated
 * per team from the Teams tab.
 */
const mocks = vi.hoisted(() => ({ useApiClient: vi.fn(), getEvent: vi.fn() }));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});
vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, getEvent: mocks.getEvent };
});

import { createApiClient } from "../../src/api/client";
import type { EventDetail } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "http://127.0.0.1:5174/api/host",
  cognitoClientId: "local-host",
  redirectUri: "http://127.0.0.1:5174/callback",
  scope: "",
  tenantId: "local-host",
  tenantName: "Local competition",
  apiBaseUrl: "http://127.0.0.1:5174/api",
  samlIdpDirectory: {},
  participantPortalUrl: "http://127.0.0.1:5175",
  features: {
    samlSso: false,
    nonAwsRuntime: false,
    redTeam: false,
    challengePrerequisiteGate: false,
  },
  mode: "local-host",
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const detail: EventDetail = {
  eventId: EVENT_ID,
  name: "Local Cup",
  status: "READY",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
  expiresAt: 0,
  teams: [
    { teamId: "t1", internalSlug: "team-alpha", teamLoginKey: "KEY-1" },
    { teamId: "t2", internalSlug: "team-beta", teamLoginKey: "KEY-2" },
  ],
  problems: [{ problemId: "sqli-demo", defaultRegion: "local" }],
  deploymentsByProblem: {
    "sqli-demo": [
      { jobId: "J1", teamId: "t1", status: "COMPLETE", gatewayPort: 5200 },
      { jobId: "J2", teamId: "t2", status: "STOPPED", gatewayPort: 5201 },
    ],
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
  mocks.useApiClient.mockReturnValue(createApiClient(config.apiBaseUrl, "a.e30.c"));
  mocks.getEvent.mockResolvedValue(detail);
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.clearAllMocks());

async function loaded() {
  renderPage();
  await waitFor(() => expect(screen.getAllByText(/Local Cup/u).length).toBeGreaterThan(0));
  return userEvent.setup();
}

describe("EventDetailPage on the local competition host", () => {
  it("hides the cloud-only Disruptions and Progression tabs", async () => {
    await loaded();
    expect(screen.getByRole("tab", { name: "Teams" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Progression/u })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Disruptions/u })).toBeNull();
  });

  it("operates environments per team and hides the AWS account column", async () => {
    const user = await loaded();
    await user.click(screen.getByRole("tab", { name: "Teams" }));
    const environments = screen.getByText("Problem environments per team").closest("div");
    expect(environments).not.toBeNull();
    const betaRow = screen.getAllByText("team-beta")[0]?.closest("tr");
    if (!betaRow) throw new Error("team-beta row is missing");
    expect(within(betaRow).getByText("5201")).toBeInTheDocument();
    expect(within(betaRow).getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText(/AWS account/u)).toBeNull();
    // The cloud self-registration panel is not offered locally.
    expect(screen.queryByText(/registration/iu)).toBeNull();
  });

  it("shows only the problem and its status, not cloud account, region or job links", async () => {
    const user = await loaded();
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    expect(screen.getByText("sqli-demo")).toBeInTheDocument();
    expect(screen.queryByText(/Job #1/u)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /Region/u })).toBeNull();
  });

  it("explains the cloud-only operations instead of loading capacity data", async () => {
    const user = await loaded();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByText("Not available in a local competition")).toBeInTheDocument();
  });

  it("offers local deploy and teardown instead of scheduled ones", async () => {
    const user = await loaded();
    await user.click(screen.getByRole("tab", { name: "Schedule" }));
    expect(screen.getByText("Problem environments")).toBeInTheDocument();
    expect(screen.queryByText(/Auto-teardown time/u)).toBeNull();
  });
});
