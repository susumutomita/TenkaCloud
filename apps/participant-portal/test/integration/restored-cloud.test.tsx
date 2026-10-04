import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { loadSession } from "../../src/auth/storage";
import { loadConfig } from "../../src/config";
import { AppConfigProvider } from "../../src/config-context";
import { applyRuntimeProblemCatalog } from "../../src/data/catalog-source";
import { I18nProvider } from "../../src/i18n";
import {
  cloudRuntime,
  consoleUrl,
  createCloudNetwork,
  eventId,
  gateId,
  hintContent,
  teamKey,
  teamRegion,
} from "./cloud-network-fixture";

// Network and window.open are the only seams replaced here. This exercises the production
// config contract with real auth/session storage, router, providers, components and API clients.
// It does not claim to deploy AWS, execute Lambda, validate IAM, or test CloudFront in a browser.
let network: ReturnType<typeof createCloudNetwork>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("tenkacloud.portal.locale", "en");
  window.history.replaceState({}, "", "/");
  vi.stubEnv("PROD", true);
  network = createCloudNetwork();
  vi.stubGlobal("fetch", network.fetcher);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(network.unexpected).toEqual([]);
});

async function boot(path = "/login", browserHistory = false) {
  const config = await loadConfig();
  expect(config).toMatchObject({ ...cloudRuntime, cloudMode: "real" });
  expect(config.notificationsEnabled).toBeUndefined();
  expect(config.scoreTimelineEnabled).toBeUndefined();
  expect(config.localTeamLoginKey).toBeUndefined();
  await applyRuntimeProblemCatalog(config);
  const routes = [{ path: "*", element: <App config={config} /> }];
  const router = browserHistory
    ? createBrowserRouter(routes)
    : createMemoryRouter(routes, { initialEntries: [path] });
  const mounted = render(
    <I18nProvider>
      <AppConfigProvider config={config}>
        <RouterProvider router={router} />
      </AppConfigProvider>
    </I18nProvider>,
  );
  return { router, ...mounted };
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText("Key distributed to your team"), teamKey);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { level: 1, name: /Welcome/ });
  expect(loadSession()).toMatchObject({ sessionToken: teamKey, teamId: "cloud-team", eventId });
}

function callsTo(path: string) {
  return network.calls.filter((call) => call.url.pathname === path);
}

function storedValues(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) =>
    storage.getItem(storage.key(index) ?? ""),
  ).join("\n");
}

function expectTeamAuthorization() {
  const calls = network.calls.filter(
    (call) =>
      call.url.pathname.startsWith("/portal/me") || call.url.pathname === "/portal/leaderboard",
  );
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url.origin).toBe(cloudRuntime.apiBaseUrl);
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${teamKey}`);
    expect(call.init.cache).toBe("no-store");
    expect(call.url.href).not.toContain(teamKey);
  }
}

describe("restored cloud participant journey (synthetic network, real SPA)", () => {
  it("keeps a rejected team key signed out instead of falling back to demo auth", async () => {
    const user = userEvent.setup();
    await boot("/problems/cloud-gate-job");
    await user.type(
      await screen.findByPlaceholderText("Key distributed to your team"),
      "invalid-team-key",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("チームログインキーが無効か、デプロイが既に削除されています。");
    expect(callsTo("/portal/me")).toHaveLength(1);
    expect(loadSession()).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(callsTo("/portal/leaderboard")).toHaveLength(0);
  });

  it("reveals hints and unlocks the next problem from refreshed cloud progression", async () => {
    const user = userEvent.setup();
    const { router } = await boot();
    await signIn(user);
    await act(() => router.navigate("/problems/cloud-next-job"));
    expect(screen.queryByRole("button", { name: /Submit flag/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("link", { name: new RegExp(gateId) }));
    expect(await screen.findByRole("button", { name: "Reveal hint" })).toBeEnabled();
    expect(screen.queryByText(hintContent)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal hint" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reveal",
      }),
    );
    expect(await screen.findByText(hintContent, { exact: false })).toBeInTheDocument();
    expect(callsTo(`/portal/me/problems/${gateId}/hints/first/reveal`)[0].method).toBe("POST");

    await user.type(screen.getByPlaceholderText("Enter value"), "synthetic-cloud-flag");
    await user.click(screen.getByRole("button", { name: "Submit flag (+100 pt)" }));
    expect(
      await screen.findByText("Congratulations. Your total score is 90 pt."),
    ).toBeInTheDocument();
    expect(screen.getByText(hintContent, { exact: false })).toBeInTheDocument();
    expect(JSON.parse(String(callsTo("/portal/me/submit-flag")[0].init.body))).toEqual({
      problemId: gateId,
      flag: "synthetic-cloud-flag",
    });
    await act(() => router.navigate("/problems/cloud-next-job"));
    expect(await screen.findByRole("button", { name: "Submit flag (+100 pt)" })).toBeEnabled();
    expectTeamAuthorization();
  });

  it("keeps notification, leaderboard and score-history routes active for the old config", async () => {
    const user = userEvent.setup();
    await boot();
    await signIn(user);
    // Dispatch each navigation click atomically: the sidebar can replace its items between
    // pointer-down and click when the initial unread-notification request completes.
    fireEvent.click(screen.getByRole("link", { name: "Notifications" }));
    expect(await screen.findByText("Cloud event notice")).toBeInTheDocument();
    expect(screen.getByText("Use your assigned team region.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Scoreboard" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Scoreboard" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("#1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Score events" }));
    expect(await screen.findByText("-10 pt")).toBeInTheDocument();
    expect(callsTo("/portal/me/notifications").length).toBeGreaterThan(0);
    expect(callsTo("/portal/me/score-events").length).toBeGreaterThan(0);
    expectTeamAuthorization();
  });

  it("requests job-scoped AWS access and uses the deployment region rather than the event region", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { router } = await boot();
    await signIn(user);
    await act(() => router.navigate("/tools/sso"));
    await user.click(await screen.findByRole("button", { name: `Open AWS Console for ${gateId}` }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(consoleUrl, "_blank", "noopener,noreferrer"),
    );
    await user.click(screen.getAllByRole("button", { name: "CLI / SDK temporary credentials" })[0]);
    await user.click((await screen.findAllByRole("button", { name: "Issue credentials" }))[0]);
    expect(await screen.findByText("SYNTHETIC_ACCESS_KEY")).toBeInTheDocument();
    expect(screen.getAllByText(teamRegion).length).toBeGreaterThan(0);
    expect(screen.queryByText(cloudRuntime.eventRegion)).not.toBeInTheDocument();
    for (const path of ["/portal/me/console-signin-url", "/portal/me/cli-credentials"]) {
      expect(callsTo(path)[0].url.search).toBe("?jobId=cloud-gate-job");
    }
    expect(storedValues(localStorage)).not.toContain("synthetic-secret");
    expect(storedValues(sessionStorage)).not.toContain("synthetic-secret");
    expectTeamAuthorization();
  });

  it("retires invitation links, then signs in with a distributed team key and sets its name", async () => {
    network = createCloudNetwork({ teamNameSetByCompetitor: false });
    vi.stubGlobal("fetch", network.fetcher);
    const user = userEvent.setup();
    const invitation = "i".repeat(43);
    const path = `/join/cloud-tenant/${eventId}`;
    window.history.replaceState({}, "", `${path}?source=event#invite=${invitation}`);
    const { router } = await boot(path, true);
    await screen.findByPlaceholderText("Key distributed to your team");
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(router.state.location.pathname).toBe("/login");
    expect(loadSession()).toBeNull();
    expect(callsTo("/portal/me")).toHaveLength(0);
    expect(network.calls.some(({ url }) => url.pathname.includes("/registration"))).toBe(false);
    expect(storedValues(localStorage)).not.toContain(invitation);
    expect(storedValues(sessionStorage)).not.toContain(invitation);
    expect(screen.queryByRole("button", { name: "Get a team environment" })).toBeNull();

    await user.type(screen.getByPlaceholderText("Key distributed to your team"), teamKey);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Choose your team name" });
    const nameInput = screen.getByPlaceholderText("e.g. Our team");
    await user.clear(nameInput);
    await user.type(nameInput, "Restored Cloud Team");
    await user.click(screen.getByRole("button", { name: "Start with this name" }));
    expect(await screen.findByRole("heading", { level: 1, name: /Welcome/ })).toBeInTheDocument();
    expect(loadSession()).toMatchObject({
      sessionToken: teamKey,
      teamName: "Restored Cloud Team",
      teamNameSetByCompetitor: true,
    });
    const patch = callsTo("/portal/me").find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ teamName: "Restored Cloud Team" });
    expect(network.calls.some(({ url }) => url.pathname.includes("/registration"))).toBe(false);
    expectTeamAuthorization();
    router.dispose();
  });
});
