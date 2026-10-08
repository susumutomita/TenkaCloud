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

vi.mock("../src/data/problems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/problems")>();
  return {
    ...actual,
    listProblemSummaries: () =>
      actual.listProblemSummaries().filter((problem) => problem.id === "ac26-crypto-battle"),
  };
});

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

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
type OrganizerRole = "Admin" | "Operator" | "Viewer";
function organizerToken(role: OrganizerRole) {
  const claims = {
    sub: `${role.toLowerCase()}-id`,
    email: `${role.toLowerCase()}@local-host`,
    "custom:tenantId": "local-host",
    "custom:userRole": role === "Viewer" ? "TenantViewer" : "TenantAdmin",
    "custom:organizerRole": role,
  };
  return `a.${btoa(JSON.stringify(claims))}.c`;
}

function stubHost(
  overrides: Record<string, Handler> = {},
  lifetime = 8 * 60 * 60_000,
  role: OrganizerRole = "Admin",
) {
  const token = organizerToken(role);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const routes: Record<string, Handler> = {
    "/api/host/login": () =>
      json({
        idToken: token,
        accessToken: token,
        refreshToken: "refresh",
        expiresAt: Date.now() + lifetime,
      }),
    "/api/events": () => json({ items: [] }),
    "/api/host/catalog": () => json({ items: [{ problemId: "ac26-crypto-battle" }] }),
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

async function signIn() {
  fireEvent.change(await screen.findByLabelText(/Organizer key|主催者キー/u), {
    target: { value: "synthetic-organizer-key" },
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
          initialEntries={[{ pathname: "/login", state: { returnPath: "/deployments" } }]}
        >
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    expect(await screen.findByText("Not available in a local competition")).toBeInTheDocument();
    // The local shell keeps competition and catalog navigation together.
    expect(screen.getAllByText("TenkaCloud Local Competition").length).toBeGreaterThan(0);
    expect(screen.queryByText("Local competition mode")).toBeNull();
    expect(screen.queryByText("Competitor accounts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to events" }));
    await waitFor(() =>
      expect(screen.queryByText("Not available in a local competition")).toBeNull(),
    );
  });

  it("restores catalog browsing and details without cloud deployment requests", async () => {
    const fetchMock = stubHost();
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/problems"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    expect(
      await screen.findByRole("heading", { name: /Problem catalog/u, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Problems" })).toHaveAttribute("href", "/problems");
    expect(screen.queryByTestId("problem-pack-guidance-open-header")).toBeNull();
    const problemLink = screen
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.startsWith("/problems/"));
    expect(problemLink).toBeDefined();
    if (!problemLink) throw new Error("Catalog has no problem detail link");
    fireEvent.click(problemLink);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/deployments"))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(
      await screen.findByRole("heading", { name: /Problem catalog/u, level: 1 }),
    ).toBeInTheDocument();
  });

  it("navigates to the local competitor account registry when AWS is configured", async () => {
    const fetchMock = stubHost({
      "/api/admin/competitor-accounts": () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={{ ...config, hostAwsRegion: "ap-northeast-1" }} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Cloud connections" }));
    expect(await screen.findByRole("heading", { name: "Cloud connections" })).toBeInTheDocument();
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input]) => String(input) === `${origin}/api/admin/competitor-accounts`,
      );
      expect(request?.[1]).toEqual({
        headers: {
          authorization: `Bearer ${organizerToken("Admin")}`,
          "content-type": "application/json",
        },
      });
    });
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
    await signIn();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${origin}/api/host/oauth2/revoke`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByLabelText("Organizer key")).toHaveValue("");
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it.each(["/users", "/identity-providers", "/audit-log", "/settings"])(
    "does not offer the removed local organizer management route %s",
    async (path) => {
      const fetchMock = stubHost();
      render(
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <App config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await signIn();
      expect(await screen.findByText("Not available in a local competition")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Identity providers" })).toBeNull();
      expect(
        fetchMock.mock.calls.some(([input]) => /\/host\/(?:users|saml)/u.test(String(input))),
      ).toBe(false);
    },
  );

  it.each(["en", "ja"] as const)("hides local audit controls in %s", async (locale) => {
    window.localStorage.setItem("tenkacloud.application-admin.locale", locale);
    const fetchMock = stubHost();
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/audit-log"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    expect(
      await screen.findByText(
        locale === "ja"
          ? "ローカル大会では使えない画面です"
          : "Not available in a local competition",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Audit log|監査ログ|Settings|設定/u })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "audit" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).includes("/admin/audit-log") || init?.method === "PUT",
      ),
    ).toBe(false);
  });
});

function Seeded({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const { setTokens, tokens } = auth;
  useEffect(() => {
    if (!tokens)
      setTokens({
        idToken: organizerToken("Admin"),
        accessToken: organizerToken("Admin"),
        expiresAt: Date.now() + 60_000,
      });
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
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many invalid credentials/u);
  });

  it("falls back to its own message when an error has no explanation", async () => {
    stubHost({ "/api/host/login": () => new Response("{}", { status: 500 }) });
    renderLoginOnly();
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Host sign-in failed/u);
  });

  it("does not exchange empty credentials submitted with Enter", async () => {
    const fetchMock = stubHost();
    renderLoginOnly();
    await screen.findByLabelText("Organizer key");
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(`${origin}/api/host/login`, expect.anything());
  });

  it("accepts a key without bootstrap or SAML status requests", () => {
    const fetchMock = stubHost();
    renderLoginOnly();
    expect(screen.getByLabelText("Organizer key")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches key sign-in and recovery instructions between Japanese and English", async () => {
    stubHost();
    renderLoginOnly();
    await screen.findByLabelText("Organizer key");
    fireEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(screen.getByLabelText("主催者キー")).toBeInTheDocument();
    expect(screen.getByText(/開催PCで make local-reset/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByLabelText("Organizer key")).toBeInTheDocument();
    expect(screen.getByText(/Run make local-reset/u)).toBeInTheDocument();
  });
});
