/**
 * Issue #3226: the organizer's journey through the normal console in local-host mode, against
 * a stubbed host API (the same wire shapes `scripts/local-host/service.ts` serves).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";
import { LocalHostLoginPage } from "../src/pages/LocalHostLogin";

const origin = window.location.origin;
const config: AppConfig = {
  cognitoDomain: `${origin}/api/host`,
  cognitoClientId: "local-host",
  redirectUri: `${origin}/callback`,
  scope: "",
  tenantId: "local-host",
  tenantName: "Local competition",
  apiBaseUrl: `${origin}/api`,
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

type Handler = (url: string, init?: RequestInit) => Response;
function stubHost(overrides: Record<string, Handler> = {}, lifetime = 15 * 60_000) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const routes: Record<string, Handler> = {
    "/api/host/login": () =>
      json({
        idToken: "a.e30.c",
        accessToken: "a.e30.c",
        refreshToken: "refresh",
        expiresAt: Date.now() + lifetime,
      }),
    "/api/events": () => json({ items: [] }),
    "/api/feature-flags": () => json({ flags: {} }),
    "/api/host/oauth2/revoke": () => json({ revoked: true }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), origin);
    const handler = routes[url.pathname];
    if (!handler) return json({ message: `unexpected ${url.pathname}` }, 404);
    return handler(url.pathname, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function signIn() {
  fireEvent.change(document.getElementById("local-host-key") as HTMLInputElement, {
    target: { value: "host-key" },
  });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
}

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("organizer journey in local-host mode", () => {
  it("returns to the requested page after sign-in and explains cloud-only pages", async () => {
    stubHost();
    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={[{ pathname: "/login", state: { returnPath: "/audit-log" } }]}
        >
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    signIn();
    expect(await screen.findByText("Not available in a local competition")).toBeInTheDocument();
    // The local shell: its own title and banner, and only the Events navigation entry.
    expect(screen.getAllByText("TenkaCloud Local Competition").length).toBeGreaterThan(0);
    expect(screen.getByText("Local competition mode")).toBeInTheDocument();
    expect(screen.queryByText("Competitor accounts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to events" }));
    await waitFor(() =>
      expect(screen.queryByText("Not available in a local competition")).toBeNull(),
    );
  });

  it("signs the organizer out when the host session's absolute lifetime ends", async () => {
    const fetchMock = stubHost({}, 150);
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    signIn();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${origin}/api/host/oauth2/revoke`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByLabelText("Host key")).toBeInTheDocument();
  });
});

function Seeded({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const { setTokens, tokens } = auth;
  useEffect(() => {
    if (!tokens)
      setTokens({ idToken: "a.e30.c", accessToken: "a.e30.c", expiresAt: Date.now() + 60_000 });
    else navigate("/login");
  }, [setTokens, navigate, tokens]);
  return <>{children}</>;
}

function renderLoginOnly(initial = "/login") {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initial]}>
        <AuthProvider config={config}>
          <Routes>
            <Route path="/seed" element={<Seeded>seeding</Seeded>} />
            <Route path="/login" element={<LocalHostLoginPage config={config} />} />
            <Route path="/events" element={<p>events page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("LocalHostLoginPage", () => {
  it("sends an organizer who is already signed in to the events page", async () => {
    renderLoginOnly("/seed");
    expect(await screen.findByText("events page")).toBeInTheDocument();
  });

  it("shows the host's own refusal, such as the invalid-credential rate limit", async () => {
    stubHost({
      "/api/host/login": () =>
        new Response(
          JSON.stringify({ message: "Too many invalid credentials; retry in one minute." }),
          {
            status: 429,
          },
        ),
    });
    renderLoginOnly();
    signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many invalid credentials/u);
  });

  it("falls back to its own message when an error has no explanation", async () => {
    stubHost({ "/api/host/login": () => new Response("{}", { status: 500 }) });
    renderLoginOnly();
    signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sign-in failed/u);
  });

  it("does not call the host for an empty key submitted with Enter", () => {
    const fetchMock = stubHost();
    renderLoginOnly();
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches the sign-in page between Japanese and English", () => {
    renderLoginOnly();
    fireEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(screen.getByLabelText("主催者キー")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByLabelText("Host key")).toBeInTheDocument();
  });
});
