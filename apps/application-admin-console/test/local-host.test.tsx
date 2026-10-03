/**
 * Issue #3226: the normal console in local-host mode (the `bun start` competition host).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
});

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
  it("uses the same-origin host API and exposes supported host features", async () => {
    const config = await localConfig();
    expect(isLocalHost(config)).toBe(true);
    expect(config.apiBaseUrl).toBe(`${origin}/api`);
    expect(config.cognitoDomain).toBe(`${origin}/api/host`);
    expect(config.participantPortalUrl).toBe("http://127.0.0.1:5175");
    expect(config.features).toMatchObject({
      redTeam: true,
      samlSso: false,
      nonAwsRuntime: false,
      challengePrerequisiteGate: false,
    });
  });

  it.each(["https://play.example.com", "https://play.example.com:8443"])(
    "accepts the public host's HTTPS participant origin: %s",
    async (participantPortalUrl) => {
      const publicOrigin = "https://admin.example.com";
      vi.stubGlobal("window", { location: { origin: publicOrigin } });
      stubRuntime({ ...runtime, apiBaseUrl: `${publicOrigin}/api`, participantPortalUrl });

      const config = await loadConfig({}, { localHostBuild: true });

      expect(isLocalHost(config)).toBe(true);
      expect(config.apiBaseUrl).toBe(`${publicOrigin}/api`);
      expect(config.cognitoDomain).toBe(`${publicOrigin}/api/host`);
      expect(config.participantPortalUrl).toBe(participantPortalUrl);
    },
  );

  it("exposes only a valid host AWS region from the same-origin runtime configuration", async () => {
    stubRuntime({ ...runtime, awsRegion: "ap-northeast-1" });
    expect((await loadConfig({}, { localHostBuild: true })).hostAwsRegion).toBe("ap-northeast-1");
    stubRuntime({ ...runtime, awsRegion: "https://attacker.example" });
    expect((await loadConfig({}, { localHostBuild: true })).hostAwsRegion).toBeUndefined();
  });

  it.each([
    { ...runtime, mode: "demo" },
    { ...runtime, role: "participant" },
    { ...runtime, apiBaseUrl: "https://evil.example/api" },
    { ...runtime, participantPortalUrl: "ftp://127.0.0.1:5175" },
    { ...runtime, participantPortalUrl: "https://play.example.com/path" },
    { ...runtime, participantPortalUrl: "//play.example.com" },
    // eslint-disable-next-line sonarjs/code-eval -- Rejected protocol fixture; never evaluated.
    { ...runtime, participantPortalUrl: "javascript:alert(1)" },
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

function stubLogin(
  exchange: () => Response | Promise<Response> = () =>
    Response.json({
      idToken: "a.b.c",
      accessToken: "a.b.c",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    }),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/host/login") return exchange();
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function submitKey(key = "synthetic-organizer-key") {
  fireEvent.change(screen.getByLabelText("Organizer key"), { target: { value: key } });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
}

describe("LocalHostLoginPage", () => {
  it("exchanges only the organizer key for a memory-only session", async () => {
    const config = await localConfig();
    const fetchMock = stubLogin();
    const save = vi.spyOn(window.localStorage, "setItem");
    const sessionSave = vi.spyOn(window.sessionStorage, "setItem");
    renderLogin(config);
    expect(screen.getByLabelText("Organizer key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Organizer key")).toHaveAttribute("autocomplete", "off");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByText(/SAML/u)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    submitKey();
    await waitFor(() => expect(screen.getByText("events page")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/host/login`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "synthetic-organizer-key" }),
      }),
    );
    for (const spy of [save, sessionSave]) {
      expect(spy.mock.calls.flat().join(" ")).not.toMatch(/synthetic-organizer-key|a.b.c|refresh/u);
    }
  });

  it("clears the key during a pending attempt and blocks duplicate submissions", async () => {
    const config = await localConfig();
    let finish!: (response: Response) => void;
    const fetchMock = stubLogin(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderLogin(config);
    submitKey();
    expect(screen.getByLabelText("Organizer key")).toHaveValue("");
    expect(screen.getByLabelText("Organizer key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(Response.json({ message: "Invalid organizer key." }, { status: 401 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid organizer key.");
    expect(screen.getByLabelText("Organizer key")).toHaveValue("");
    expect(screen.getByLabelText("Organizer key")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.queryByText("events page")).toBeNull();
  });

  it("allows a new key after a rejected attempt", async () => {
    const config = await localConfig();
    let attempts = 0;
    stubLogin(() =>
      ++attempts === 1
        ? Response.json({ message: "Invalid organizer key." }, { status: 401 })
        : Response.json({
            idToken: "a.b.c",
            accessToken: "a.b.c",
            refreshToken: "refresh",
            expiresAt: Date.now() + 60_000,
          }),
    );
    renderLogin(config);
    submitKey("wrong-key");
    await screen.findByRole("alert");
    submitKey("replacement-key");
    expect(await screen.findByText("events page")).toBeInTheDocument();
  });

  it.each([
    ["non-JSON", "<html>Bad gateway</html>", 502],
    ["null", "null", 500],
    ["array", "[]", 500],
    ["incomplete session", '{"idToken":"a.b.c"}', 200],
  ])("rejects a %s response without retaining the key", async (_label, body, status) => {
    const config = await localConfig();
    stubLogin(() => new Response(body, { status }));
    renderLogin(config);
    submitKey();
    expect(await screen.findByRole("alert")).toHaveTextContent("Host sign-in failed.");
    expect(screen.getByLabelText("Organizer key")).toHaveValue("");
    expect(screen.queryByText("events page")).toBeNull();
  });

  it("reports a network failure without retaining the key", async () => {
    const config = await localConfig();
    stubLogin(() => Promise.reject(new Error("Host is offline.")));
    renderLogin(config);
    submitKey();
    expect(await screen.findByRole("alert")).toHaveTextContent("Host is offline.");
    expect(screen.getByLabelText("Organizer key")).toHaveValue("");
  });

  it("explains key rotation without implying that competition data is deleted", async () => {
    const config = await localConfig();
    stubLogin();
    renderLogin(config);
    expect(screen.getByText(/make local-reset/u)).toHaveTextContent(
      "rotate the key and sign out all organizers. Events, participant access, scores, and problem environments are preserved.",
    );
  });
});

describe("local-host routes", () => {
  it("sends an unauthenticated organizer to the local key sign-in", async () => {
    const config = await localConfig();
    stubLogin();
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/competitor-accounts"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(await screen.findByLabelText("Organizer key")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
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

  it("keeps the newest client's catalog when an older answer arrives late", async () => {
    let answerOld = (_value: unknown): void => undefined;
    const oldClient = {
      get: vi.fn().mockReturnValue(new Promise((accept) => (answerOld = accept))),
    };
    const newClient = { get: vi.fn().mockResolvedValue({ items: [{ problemId: "new" }] }) };
    let captured: ReturnType<typeof useHostCatalog> | undefined;
    function Probe({ client }: { client: never }) {
      captured = useHostCatalog(client);
      return null;
    }
    const view = render(<Probe client={oldClient as never} />);
    view.rerender(<Probe client={newClient as never} />);
    await waitFor(() => expect(captured?.supported.has("new")).toBe(true));
    answerOld({ items: [{ problemId: "old" }] });
    await new Promise((accept) => setTimeout(accept, 0));
    expect(captured?.supported.has("old")).toBe(false);
  });

  it("does not report a failure from a client that has since been replaced", async () => {
    let failOld = (_reason: unknown): void => undefined;
    const oldClient = {
      get: vi.fn().mockReturnValue(new Promise((_accept, reject) => (failOld = reject))),
    };
    const newClient = { get: vi.fn().mockResolvedValue({ items: [{ problemId: "new" }] }) };
    let captured: ReturnType<typeof useHostCatalog> | undefined;
    function Probe({ client }: { client: never }) {
      captured = useHostCatalog(client);
      return null;
    }
    const view = render(<Probe client={oldClient as never} />);
    view.rerender(<Probe client={newClient as never} />);
    await waitFor(() => expect(captured?.supported.has("new")).toBe(true));
    failOld(new Error("old host down"));
    await new Promise((accept) => setTimeout(accept, 0));
    expect(captured?.error).toBeNull();
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
