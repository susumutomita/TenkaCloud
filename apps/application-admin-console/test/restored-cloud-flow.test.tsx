import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { EventDetail } from "../src/api/events-client";
import { rememberLoginReturnPath } from "../src/auth/login-return-path";
import { loadConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";

/**
 * Synthetic-network jsdom integration, not an AWS or browser rehearsal. Only fetch is
 * replaced: configuration, PKCE callback, memory auth, router, catalog, Cloudscape forms,
 * and HTTP clients are real. Fixtures use the restored Lite API's existing wire contract.
 */
const API = "https://api.example.com/prod";
const DOMAIN = "https://restored.auth.ap-northeast-1.amazoncognito.com";
const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const ACCOUNT_ID = "111111111111";
const runtime = {
  cognitoDomain: DOMAIN,
  userClientId: "restored-client",
  tenantId: "local",
  tenantName: "TenkaCloud",
  apiUrl: API,
  participantPortalUrl: "https://participants.example.com",
  competitorBootstrapTemplateUrl: "https://bootstrap.s3.ap-northeast-1.amazonaws.com/template.yaml",
  isolation: "silo",
  samlIdpDirectory: {},
  eventLimits: { maxTeams: 99, maxProblems: 50 },
};
const account = {
  awsAccountId: ACCOUNT_ID,
  region: "ap-northeast-1",
  competitorRoleName: "TenkaCloud-local-deploy-Role",
  verified: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const detail: EventDetail = {
  eventId: EVENT_ID,
  name: "Restored cloud event",
  status: "READY",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  expiresAt: 0,
  teams: [
    { teamId: "team-a", internalSlug: "team-1", awsAccountId: ACCOUNT_ID },
    { teamId: "team-b", internalSlug: "team-2", awsAccountId: ACCOUNT_ID },
  ],
  problems: [{ problemId: "hello-world-battle", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
  scoreEventsByTeam: [],
};
const organizer = {
  username: "synthetic-organizer",
  email: "viewer@example.com",
  role: "TenantViewer",
  enabled: true,
};
const apiResponses: Readonly<Record<string, unknown>> = {
  "GET /prod/feature-flags": { flags: { challengePrerequisiteGate: true, redTeam: true } },
  "GET /prod/admin/competitor-accounts": { items: [account] },
  "GET /prod/admin/users": { items: [organizer] },
  "PATCH /prod/admin/users/synthetic-organizer": {
    item: { ...organizer, role: "TenantOperator" },
  },
  [`POST /prod/admin/competitor-accounts/${ACCOUNT_ID}/verify`]: account,
  "POST /prod/events": {
    eventId: EVENT_ID,
    teams: detail.teams.map((team) => ({ ...team, teamLoginKey: `synthetic-key-${team.teamId}` })),
  },
  [`GET /prod/events/${EVENT_ID}`]: detail,
};

interface RequestRecord {
  url: URL;
  method: string;
  init?: RequestInit;
}
let requests: RequestRecord[];
let unexpected: string[];
let idToken: string;

function syntheticToken(role: string) {
  return `header.${btoa(
    JSON.stringify({
      email: "organizer@example.com",
      "custom:tenantId": "local",
      "custom:userRole": role,
    }),
  )}.synthetic-signature`;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("tenkacloud.application-admin.locale", "en");
  requests = [];
  unexpected = [];
  idToken = syntheticToken("TenantAdmin");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const method = init?.method ?? "GET";
      requests.push({ url, method, init });
      if (url.pathname === "/runtime-config.json") return Response.json(runtime);
      if (url.origin === DOMAIN && url.pathname === "/oauth2/token")
        return Response.json({
          id_token: idToken,
          access_token: "synthetic-access",
          expires_in: 3600,
        });
      if (url.origin === new URL(API).origin) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${idToken}`);
        const body = apiResponses[`${method} ${url.pathname}`];
        if (body !== undefined) return Response.json(body);
      }
      unexpected.push(`${method} ${url}`);
      throw new Error(`Unexpected synthetic request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  expect(unexpected).toEqual([]);
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

async function openAuthenticated(path: string, role = "TenantAdmin") {
  idToken = syntheticToken(role);
  const config = await loadConfig({}, { localHostBuild: false });
  expect(config.mode).toBeUndefined();
  expect(config.tenantId).toBe("local");
  expect(config.eventLimits).toEqual({ maxTeams: 99, maxProblems: 50 });
  sessionStorage.setItem("TenkaCloud.pkce_verifier", "synthetic-verifier");
  sessionStorage.setItem("TenkaCloud.oauth_state", "synthetic-state");
  rememberLoginReturnPath(path);
  window.history.replaceState(null, "", "/callback?code=synthetic-code&state=synthetic-state");
  const rendered = render(
    <I18nProvider>
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </I18nProvider>,
  );
  await waitFor(() => expect(window.location.pathname).toBe(path));
  return rendered;
}

describe("restored cloud SPA with synthetic HTTP", () => {
  it("lets TenantAdmin verify accounts after real config and Cognito callback processing", async () => {
    await openAuthenticated("/competitor-accounts");
    const verify = await screen.findByRole("button", { name: "Re-verify" });
    expect(verify).toBeEnabled();
    fireEvent.click(verify);
    await waitFor(() =>
      expect(
        requests.some(
          ({ url, method }) => url.pathname.endsWith(`/${ACCOUNT_ID}/verify`) && method === "POST",
        ),
      ).toBe(true),
    );
    const exchange = requests.find(({ url }) => url.pathname === "/oauth2/token");
    expect(new URLSearchParams(String(exchange?.init?.body)).get("client_id")).toBe(
      "restored-client",
    );
    expect(new URLSearchParams(String(exchange?.init?.body)).get("code_verifier")).toBe(
      "synthetic-verifier",
    );
    expect(sessionStorage.getItem("TenkaCloud.pkce_verifier")).toBeNull();
    expect(requests.some(({ url }) => url.pathname === "/prod/feature-flags")).toBe(true);
  });

  it.each(["TenantOperator", "TenantViewer"])(
    "keeps account trust controls disabled for %s",
    async (role) => {
      await openAuthenticated("/competitor-accounts", role);
      expect(await screen.findByRole("button", { name: "Re-verify" })).toBeDisabled();
    },
  );

  it("shows organizer role labels while retaining the restored user API role values", async () => {
    await openAuthenticated("/users");
    await screen.findByText("viewer@example.com");
    const role = createWrapper(screen.getByRole("table")).findSelect();
    expect(role?.findTrigger().getElement()).toHaveTextContent("Organizer viewer");
    role?.openDropdown();
    role?.selectOptionByValue("TenantOperator", { expandToViewport: true });
    await waitFor(() =>
      expect(role?.findTrigger().getElement()).toHaveTextContent("Organizer operator"),
    );
    const change = requests.find(({ method }) => method === "PATCH");
    expect(change?.url.pathname).toBe("/prod/admin/users/synthetic-organizer");
    expect(JSON.parse(String(change?.init?.body))).toEqual({ role: "TenantOperator" });
  });

  // Instrumented Cloudscape rendering across sign-in, creation and detail takes about
  // five seconds on one CPU. Keep each Testing Library wait at its bounded default
  // and give this complete journey a separate budget from individual unit tests.
  it("creates two teams in one AWS account with different regions and opens the created event", async () => {
    const { container } = await openAuthenticated("/events/new");
    await screen.findByRole("heading", { name: "Create new Event" });
    await waitFor(() =>
      expect(createWrapper(container).findAllSelects()[0]?.isDisabled()).toBe(false),
    );
    const wrapper = createWrapper(container);
    wrapper.findAllInputs()[1]?.setInputValue("2");
    wrapper.findAllInputs()[0]?.setInputValue("Restored cloud event");
    const problems = wrapper.findMultiselect('[data-testid="problem-select"]');
    problems?.openDropdown();
    expect(problems?.findDropdown()?.findOptionByValue("hello-world-battle")).not.toBeNull();
    expect(problems?.findDropdown()?.findOptionByValue("ac26-crypto-battle")).not.toBeNull();
    expect(problems?.findDropdown()?.findOptionByValue("db-battle-slow-apparently")).toBeNull();
    problems?.selectOptionByValue("hello-world-battle");
    for (const [index, region] of ["ap-northeast-1", "us-east-1"].entries()) {
      const selects = createWrapper(container).findAllSelects();
      selects[index * 2]?.openDropdown();
      selects[index * 2]?.selectOptionByValue(ACCOUNT_ID, { expandToViewport: true });
      selects[index * 2 + 1]?.openDropdown();
      selects[index * 2 + 1]?.selectOptionByValue(region, { expandToViewport: true });
    }
    const submit = screen.getByRole("button", { name: /^Create Event$/ });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByTestId("deploy-prompt-now");
    const creation = requests.find(
      ({ url, method }) => url.pathname === "/prod/events" && method === "POST",
    );
    expect(JSON.parse(String(creation?.init?.body)).teams).toEqual([
      { internalSlug: "team-1", awsAccountId: ACCOUNT_ID, region: "ap-northeast-1" },
      { internalSlug: "team-2", awsAccountId: ACCOUNT_ID, region: "us-east-1" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /later/i }));
    await screen.findByRole("tab", { name: /Overview/ });
    expect(
      requests
        .find(({ url }) => url.pathname === `/prod/events/${EVENT_ID}`)
        ?.url.searchParams.get("withScoreEvents"),
    ).toBe("true");
  }, 15_000);

  it("retains the full event routes for an authenticated organizer", async () => {
    await openAuthenticated(`/events/${EVENT_ID}`);
    await screen.findByRole("tab", { name: /Overview/ });
    for (const name of [
      /Schedule/,
      /Problems/,
      /Teams/,
      /Scoreboard/,
      /Notifications/,
      /Progression/,
    ])
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(await screen.findByRole("button", { name: "Send notification" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: /^Teams$/ }));
    expect(await screen.findByRole("link", { name: runtime.participantPortalUrl })).toHaveAttribute(
      "href",
      runtime.participantPortalUrl,
    );
    for (const team of detail.teams) {
      const row = screen.getByText(team.internalSlug).closest("tr");
      if (!row) throw new Error(`Team row missing: ${team.internalSlug}`);
      expect(within(row).getByRole("button", { name: "Regenerate key" })).toBeEnabled();
    }
    expect(screen.queryByText("Assign teams through a registration link")).toBeNull();
    expect(requests.some(({ url }) => url.pathname.includes("/registration"))).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: /Progression/ }));
    await waitFor(() =>
      expect(
        requests.filter(({ url }) => url.pathname === "/prod/feature-flags").length,
      ).toBeGreaterThan(1),
    );
  });
});
