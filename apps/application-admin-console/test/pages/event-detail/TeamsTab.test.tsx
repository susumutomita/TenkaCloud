import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../src/api/client";
import type { EventDetail } from "../../../src/api/events-client";
import type { AppConfig } from "../../../src/config";
import { I18nProvider, useT } from "../../../src/i18n";
import type { EventTabContentProps } from "../../../src/pages/event-detail/tab-content-props";
import { TeamsTab } from "../../../src/pages/event-detail/tabs";

// Keep the production React panels and API client: retired registration must make no request,
// while distribution, copying and rotation of the existing team keys remain usable.
const portalUrl = "https://participants.example.test";
const apiBaseUrl = "https://api.example.test";
const detail: EventDetail = {
  eventId: "event-1",
  name: "Team key distribution",
  status: "READY",
  teamCount: 1,
  problemCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  expiresAt: 0,
  teams: [{ teamId: "team-1", internalSlug: "team-alpha", teamLoginKey: "TEAM-KEY" }],
  problems: [{ problemId: "problem-1", defaultRegion: "local" }],
  deploymentsByProblem: {},
};
const writeText = vi.fn().mockResolvedValue(undefined);
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (init?.method !== "POST" || url.pathname !== "/events/event-1/teams/team-1/rotate-login-key") {
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }
  return Response.json({
    kind: "ok",
    teamId: "team-1",
    teamLoginKey: "REPLACEMENT-KEY",
    rotatedAt: "2026-10-04T00:00:00Z",
  });
});

function Harness({ mode }: { mode: AppConfig["mode"] }) {
  const t = useT();
  const config: AppConfig = {
    mode,
    cognitoDomain: "https://auth.example.test",
    cognitoClientId: "test-client",
    redirectUri: "https://organizer.example.test/callback",
    scope: "openid",
    tenantId: "tenant-1",
    tenantName: "Test host",
    apiBaseUrl,
    samlIdpDirectory: {},
    participantPortalUrl: portalUrl,
  };
  const props = {
    apiClient: createApiClient(apiBaseUrl, "test-token"),
    canMutateTenant: true,
    config,
    detail,
    manualRefresh: vi.fn(),
    t,
  } as unknown as EventTabContentProps;
  return <TeamsTab {...props} />;
}

beforeEach(() => {
  localStorage.setItem("tenkacloud.application-admin.locale", "en");
  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TeamsTab participant distribution without self-registration", () => {
  it.each([
    ["local host", "local-host"],
    ["cloud host", "cloud-host"],
    ["legacy backend", undefined],
  ] as const)("retains portal and team keys on %s", async (_label, mode) => {
    render(
      <I18nProvider>
        <Harness mode={mode} />
      </I18nProvider>,
    );
    expect(screen.getByRole("link", { name: portalUrl })).toHaveAttribute("href", portalUrl);
    expect(screen.getByText("TEAM-KEY")).toBeInTheDocument();
    expect(screen.getByText(/Share the Portal URL above and one key/)).toBeInTheDocument();
    expect(screen.queryByText("Assign teams through a registration link")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /registration|invitation|invite link/i }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Copy Portal URL" }));
    expect(writeText).toHaveBeenCalledWith(portalUrl);
    fireEvent.click(screen.getByRole("button", { name: "Copy team login key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("TEAM-KEY"));
    expect(fetcher).not.toHaveBeenCalled();

    const teamRow = screen.getByText("TEAM-KEY").closest("tr");
    if (!teamRow) throw new Error("Team key row is missing");
    fireEvent.click(within(teamRow).getByRole("button", { name: "Regenerate key" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Regenerate key" }),
    );
    expect(await screen.findAllByText("REPLACEMENT-KEY")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `${apiBaseUrl}/events/event-1/teams/team-1/rotate-login-key`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy new key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("REPLACEMENT-KEY"));
  });
});
