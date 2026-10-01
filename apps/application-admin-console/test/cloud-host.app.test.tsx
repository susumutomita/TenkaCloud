/**
 * Cloud organizer acceptance through the real SPA, router, auth and API client in jsdom.
 * Only HTTP responses are synthetic; this does not exercise Cognito, AWS or a browser engine.
 */
import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type {
  CompetitorAccountSummary,
  CreateCompetitorAccountRequest,
} from "../src/api/competitor-accounts-client";
import type { EventDetail } from "../src/api/events-client";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";

const config: AppConfig = {
  mode: "cloud-host",
  supportedProblemIds: ["hello-world"],
  cognitoDomain: "https://organizers.example.test",
  cognitoClientId: "synthetic-cloud-client",
  redirectUri: "https://console.example.test/callback",
  scope: "openid email",
  tenantId: "cloud-host",
  tenantName: "Cloud competition",
  apiBaseUrl: "https://api.example.test",
  competitorRoleName: "TenkaCloudCompetitionRole",
  competitorBootstrapTemplateUrl: "https://assets.example.test/competitor-bootstrap.yaml",
  samlIdpDirectory: {},
};
const eventId = "01J00000000000000000000000";
const createdAt = "2026-10-01T00:00:00.000Z";

function account(awsAccountId: string, alias: string): CompetitorAccountSummary {
  return {
    awsAccountId,
    alias,
    region: "ap-northeast-1",
    competitorRoleName: "TenkaCloudCompetitionRole",
    verified: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function cloudSession(role: "Admin" | "Operator" | "Viewer", destination = "/competitor-accounts") {
  const token = `a.${btoa(JSON.stringify({ sub: "organizer", "custom:userRole": role }))}.c`;
  const accounts: CompetitorAccountSummary[] = [
    { ...account("222222222222", "Beta account"), verified: true, verifiedAt: createdAt },
  ];
  const event: EventDetail = {
    eventId,
    name: "Cloud acceptance event",
    status: "DRAFT",
    teamCount: 2,
    problemCount: 1,
    createdAt,
    updatedAt: createdAt,
    expiresAt: 1_900_000_000,
    teams: [
      { teamId: "alpha", internalSlug: "alpha", awsAccountId: "111111111111" },
      { teamId: "beta", internalSlug: "beta", awsAccountId: "222222222222" },
    ],
    problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
    deploymentsByProblem: {},
    scoreEventsByTeam: [],
  };
  const unexpected: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let deployAttempts = 0;
  const routes: Record<string, (init?: RequestInit) => Response> = {
    [`POST ${config.cognitoDomain}/oauth2/token`]: () =>
      json({ id_token: token, access_token: token, expires_in: 3600 }),
    [`GET ${config.apiBaseUrl}/feature-flags`]: () => json({ flags: {} }),
    [`GET ${config.apiBaseUrl}/admin/competitor-accounts`]: () => json({ items: accounts }),
    [`POST ${config.apiBaseUrl}/admin/competitor-accounts`]: (init) => {
      const body = JSON.parse(String(init?.body)) as CreateCompetitorAccountRequest;
      const registered = account(body.awsAccountId, body.alias ?? "");
      accounts.push(registered);
      return json(
        {
          ...registered,
          externalId: "synthetic-shared-external-id",
          tenkaCloudAccountId: "999999999999",
        },
        201,
      );
    },
    [`POST ${config.apiBaseUrl}/admin/competitor-accounts/111111111111/verify`]: () => {
      const registered = accounts.find((item) => item.awsAccountId === "111111111111");
      if (!registered) throw new Error("Cannot verify an unregistered account");
      registered.verified = true;
      registered.verifiedAt = createdAt;
      return json(registered);
    },
    [`GET ${config.apiBaseUrl}/events`]: () => json({ items: [event] }),
    [`GET ${config.apiBaseUrl}/events/${eventId}`]: () => json(event),
    [`POST ${config.apiBaseUrl}/events/${eventId}/deploy`]: () => {
      deployAttempts += 1;
      if (deployAttempts === 1) return json({ error: "deployment_acceptance_unavailable" }, 503);
      event.status = "DEPLOYING";
      event.deploymentsByProblem = {
        "hello-world": [
          { jobId: "alpha-job", teamId: "alpha", status: "PENDING" },
          { jobId: "beta-job", teamId: "beta", status: "PENDING" },
        ],
      };
      return json({ eventId, enqueued: 2, skipped: 0 }, 202);
    },
    [`DELETE ${config.apiBaseUrl}/events/${eventId}`]: () => {
      event.status = "TEARDOWN";
      event.deploymentsByProblem = {
        "hello-world": [
          { jobId: "alpha-job", teamId: "alpha", status: "DELETING" },
          { jobId: "beta-job", teamId: "beta", status: "PENDING" },
        ],
      };
      // The real DELETE route reports each target's durable teardown acceptance separately.
      return json({ eventId, enqueued: 1, skipped: 0, failed: 1 }, 202);
    },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;
    const handler = routes[key];
    if (handler) return handler(init);
    unexpected.push(key);
    throw new Error(`Unexpected synthetic cloud request: ${key}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.setItem("TenkaCloud.pkce_verifier", "synthetic-pkce-verifier");
  sessionStorage.setItem("TenkaCloud.oauth_state", "synthetic-state");
  sessionStorage.setItem("TenkaCloud.application_admin.login_return_path", destination);
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/callback?code=synthetic-code&state=synthetic-state"]}>
        <App config={config} />
      </MemoryRouter>
    </I18nProvider>,
  );
  return { fetchMock, token, unexpected };
}

beforeEach(() => {
  sessionStorage.clear();
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("cloud organizer SPA journey", () => {
  // Full Cloudscape journey crosses several routes/dialogs; parallel workspace runs exceed the 5s unit-test default.
  it("registers and verifies an account, retries cloud deployment, and reports partial teardown", async () => {
    const { fetchMock, token, unexpected } = cloudSession("Admin");
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    const add = screen.getByRole("dialog", { name: "Add Competitor Account" });
    expect(within(add).getByLabelText("IAM Role name")).toHaveValue(config.competitorRoleName);
    expect(within(add).getByLabelText("IAM Role name")).toBeDisabled();
    fireEvent.change(within(add).getByLabelText("AWS Account ID"), {
      target: { value: "111111111111" },
    });
    fireEvent.change(within(add).getByLabelText("Alias (optional)"), {
      target: { value: "Alpha account" },
    });
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));

    await screen.findByText("Information to share with the competitor");
    const launch = screen.getByRole("link", { name: "Launch Stack (Quick-create deeplink)" });
    const launchParams = new URLSearchParams(
      new URL(launch.getAttribute("href") ?? "").hash.split("?")[1],
    );
    expect(launchParams.get("param_RoleName")).toBe(config.competitorRoleName);
    expect(launchParams.get("param_ExternalId")).toBe("synthetic-shared-external-id");
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Information to share with the competitor" }),
      ).getByRole("button", { name: "Close" }),
    );
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(screen.queryByText("Unverified")).not.toBeInTheDocument());
    expect(screen.getAllByText("Verified")).toHaveLength(2);

    const alphaRow = screen.getByText("Alpha account").closest("tr");
    if (!alphaRow) throw new Error("Missing verified competitor account row");
    fireEvent.click(within(alphaRow).getByRole("button", { name: "Delete" }));
    const deletion = screen.getByRole("dialog", { name: "Delete account" });
    expect(deletion).toHaveTextContent(
      "The shared ExternalId and the competitor-owned bootstrap stack and IAM role are retained",
    );
    fireEvent.click(within(deletion).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("link", { name: "Events" }));
    fireEvent.click(await screen.findByRole("link", { name: "Cloud acceptance event" }));
    expect(
      await screen.findByRole("heading", { name: "Cloud acceptance event" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Deploy now" }));

    expect(await screen.findByText(/deployment_acceptance_unavailable/u)).toBeInTheDocument();
    expect(screen.queryByText("Deploy / Delete accepted")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deploy now" }));
    expect(await screen.findByText(/Accepted: 2 \/ skipped: 0/u)).toBeInTheDocument();
    expect(screen.queryByText(/deployment_acceptance_unavailable/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(await screen.findByText("Deploying… (0 / 2)")).toBeInTheDocument();
    expect(screen.queryByText("Deploy complete", { exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Teardown now" }));
    const teardown = screen.getByRole("dialog", { name: "Delete all deployments for this Event?" });
    const remove = within(teardown).getByRole("button", { name: "Delete all" });
    expect(remove).toBeDisabled();
    fireEvent.change(within(teardown).getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(remove);
    expect(
      await screen.findByText(/Acceptance failed or is unconfirmed for 1 targets\./u),
    ).toHaveTextContent("Accepted work is not the same as completed work.");
    const result = createWrapper(document.body).findAlert();
    expect(result?.findRootElement().getElement().className).toContain("type-warning");
    expect(result?.findContent().getElement()).toHaveTextContent("Accepted: 1 / skipped: 0");
    await waitFor(() =>
      expect(
        createWrapper(document.body)
          .findAllModals()
          .some((modal) => modal.isVisible()),
      ).toBe(false),
    );

    const mutations = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).startsWith(config.apiBaseUrl) && (init?.method ?? "GET") !== "GET",
    );
    expect(mutations.map(([input]) => String(input))).toEqual([
      `${config.apiBaseUrl}/admin/competitor-accounts`,
      `${config.apiBaseUrl}/admin/competitor-accounts/111111111111/verify`,
      `${config.apiBaseUrl}/events/${eventId}/deploy`,
      `${config.apiBaseUrl}/events/${eventId}/deploy`,
      `${config.apiBaseUrl}/events/${eventId}`,
    ]);
    expect(JSON.parse(String(mutations[0]?.[1]?.body))).toEqual({
      awsAccountId: "111111111111",
      alias: "Alpha account",
      region: "ap-northeast-1",
      competitorRoleName: config.competitorRoleName,
    });
    expect(JSON.parse(String(mutations[2]?.[1]?.body))).toEqual({});
    const firstKey = new Headers(mutations[2]?.[1]?.headers).get("Idempotency-Key");
    expect(firstKey).toBeTruthy();
    expect(new Headers(mutations[3]?.[1]?.headers).get("Idempotency-Key")).toBe(firstKey);
    expect(mutations[4]?.[1]?.method).toBe("DELETE");
    for (const [input, init] of fetchMock.mock.calls)
      if (String(input).startsWith(config.apiBaseUrl))
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(unexpected).toEqual([]);
  }, 15_000);

  it("opens the authenticated root on Events and exposes only connected cloud navigation", async () => {
    const f = cloudSession("Admin", "/");
    expect(await screen.findByRole("link", { name: "Cloud acceptance event" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Competitor Accounts" })).toBeInTheDocument();
    for (const label of ["Users", "Settings", "Audit log", "Deployments", "Problems"])
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    expect(f.fetchMock.mock.calls.some(([input]) => String(input).endsWith("/feature-flags"))).toBe(
      false,
    );
    expect(f.unexpected).toEqual([]);
  });
  it.each([
    "/users",
    "/settings",
    "/audit-log",
    "/deployments",
    "/problems",
    "/identity-providers",
  ])("explains unavailable cloud route %s without sending a legacy API request", async (path) => {
    const f = cloudSession("Admin", path);
    expect(
      await screen.findByRole("heading", {
        name: "This function is not available in cloud hosting yet",
      }),
    ).toBeInTheDocument();
    expect(
      f.fetchMock.mock.calls.filter(([input]) => String(input).startsWith(config.apiBaseUrl)),
    ).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Go to events" }));
    expect(await screen.findByRole("link", { name: "Cloud acceptance event" })).toBeInTheDocument();
    expect(f.unexpected).toEqual([]);
  });

  it.each(["Operator", "Viewer"] as const)(
    "keeps account mutations disabled for a cloud %s",
    async (role) => {
      const { fetchMock, unexpected } = cloudSession(role);
      await screen.findByText("Beta account");
      const row = screen.getByText("Beta account").closest("tr");
      if (!row) throw new Error("Missing competitor account row");
      const buttons = [
        screen.getByRole("button", { name: "Add account" }),
        screen.getByRole("button", { name: "Bulk import (JSON)" }),
        within(row).getByRole("button", { name: "Re-verify" }),
        within(row).getByRole("button", { name: "Delete" }),
      ];
      for (const button of buttons) {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
      expect(
        createWrapper(document.body)
          .findAllModals()
          .some((modal) => modal.isVisible()),
      ).toBe(false);
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            String(input).startsWith(config.apiBaseUrl) && (init?.method ?? "GET") !== "GET",
        ),
      ).toEqual([]);
      expect(unexpected).toEqual([]);
    },
  );
});
