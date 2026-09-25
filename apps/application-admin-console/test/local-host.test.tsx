/**
 * Issue #3226: the normal console in local-host mode (the `bun start` competition host).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider } from "../src/auth/AuthProvider";
import { type AppConfig, isLocalHost, loadConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";
import { buildProblemOptions } from "../src/pages/event-create/helpers";
import { useHostCatalog } from "../src/pages/event-create/LocalHostEventCreate";
import { LocalHostLoginPage } from "../src/pages/LocalHostLogin";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const origin = window.location.origin;
const runtime = {
  mode: "local-host",
  role: "admin",
  apiBaseUrl: `${origin}/api`,
  participantPortalUrl: "http://127.0.0.1:5175",
};

function stubRuntime(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function localConfig(): Promise<AppConfig> {
  stubRuntime(runtime);
  return loadConfig({}, { localHostBuild: true });
}

describe("loadConfig in the local hosting build", () => {
  it("uses the same-origin host API and turns cloud-only features off", async () => {
    const config = await localConfig();
    expect(isLocalHost(config)).toBe(true);
    expect(config.apiBaseUrl).toBe(`${origin}/api`);
    expect(config.cognitoDomain).toBe(`${origin}/api/host`);
    expect(config.participantPortalUrl).toBe("http://127.0.0.1:5175");
    expect(config.features).toMatchObject({
      redTeam: false,
      samlSso: false,
      nonAwsRuntime: false,
      challengePrerequisiteGate: false,
    });
  });

  it.each([
    { ...runtime, mode: "demo" },
    { ...runtime, role: "participant" },
    { ...runtime, apiBaseUrl: "https://evil.example/api" },
    { ...runtime, participantPortalUrl: "ftp://127.0.0.1:5175" },
  ])("refuses a configuration that does not describe this host: %o", async (body) => {
    stubRuntime(body);
    await expect(loadConfig({}, { localHostBuild: true })).rejects.toThrow(/No demo or cloud/u);
  });

  it("fails loudly when the host configuration is missing", async () => {
    stubRuntime({}, 404);
    await expect(loadConfig({}, { localHostBuild: true })).rejects.toThrow(/unavailable/u);
  });

  it("never enters local-host mode outside the hosting build", async () => {
    stubRuntime(runtime);
    const config = await loadConfig({
      VITE_COGNITO_DOMAIN: "https://dev.auth.example.com",
      VITE_COGNITO_CLIENT_ID: "client",
    });
    expect(isLocalHost(config)).toBe(false);
  });

  it("ignores a stray VITE_LOCAL_HOST in a cloud build's environment", async () => {
    stubRuntime(runtime);
    const config = await loadConfig({
      VITE_LOCAL_HOST: "1",
      VITE_COGNITO_DOMAIN: "https://dev.auth.example.com",
      VITE_COGNITO_CLIENT_ID: "client",
    });
    expect(isLocalHost(config)).toBe(false);
  });
});

function renderLogin(config: AppConfig) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider config={config}>
          <Routes>
            <Route path="/login" element={<LocalHostLoginPage config={config} />} />
            <Route path="/events" element={<p>events page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("LocalHostLoginPage", () => {
  it("exchanges the host key for a session and opens the events page", async () => {
    const config = await localConfig();
    const fetchMock = stubRuntime({
      idToken: "a.b.c",
      accessToken: "a.b.c",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    });
    renderLogin(config);
    fireEvent.change(document.getElementById("local-host-key") as HTMLInputElement, {
      target: { value: "host-key" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByText("events page")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/host/login`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ key: "host-key" }) }),
    );
  });

  it("says when the key is wrong instead of signing in", async () => {
    const config = await localConfig();
    stubRuntime({ message: "Invalid host key." }, 401);
    renderLogin(config);
    fireEvent.change(document.getElementById("local-host-key") as HTMLInputElement, {
      target: { value: "wrong" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("events page")).toBeNull();
  });
});

describe("LocalHostLoginPage error bodies", () => {
  it("shows the sign-in failure message for a non-JSON error response", async () => {
    const config = await localConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })),
    );
    renderLogin(config);
    fireEvent.change(document.getElementById("local-host-key") as HTMLInputElement, {
      target: { value: "host-key" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Sign-in failed|サインインできませんでした/u);
    expect(alert.textContent).not.toMatch(/JSON|Unexpected token/u);
  });
});

describe("local-host routes", () => {
  it("sends an unauthenticated organizer to the host-key sign-in, not Cognito", async () => {
    const config = await localConfig();
    window.history.pushState({}, "", "/competitor-accounts");
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/competitor-accounts"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(await screen.findByLabelText(/主催者キー|Host key/u)).toBeInTheDocument();
  });
});

describe("local host problem selection", () => {
  it("offers only the problems the host catalog supports", () => {
    const options = buildProblemOptions(
      [
        { id: "sqli-demo", name: "SQL", runtime: { provider: "docker", engine: "compose" } },
        { id: "cloud", name: "Cloud", runtime: { provider: "aws", engine: "cloudformation" } },
      ],
      "unsupported",
      new Set(),
      new Set(["sqli-demo"]),
    );
    expect(options.map((option) => option.disabled ?? false)).toEqual([false, true]);
  });

  it("loads the host catalog and reports a failure", async () => {
    const ok = { get: vi.fn().mockResolvedValue({ items: [{ problemId: "sqli-demo" }] }) };
    let captured: ReturnType<typeof useHostCatalog> | undefined;
    function Probe({ client }: { client: never }) {
      captured = useHostCatalog(client);
      return null;
    }
    render(<Probe client={ok as never} />);
    await waitFor(() => expect(captured?.supported.has("sqli-demo")).toBe(true));
    const failing = { get: vi.fn().mockRejectedValue(new Error("down")) };
    render(<Probe client={failing as never} />);
    await waitFor(() => expect(captured?.error).toMatch(/down/u));
  });
});
