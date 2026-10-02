/**
 * Issue #3226: the organizer's journey through the normal console in local-host mode, against
 * a stubbed host API (the same wire shapes `scripts/local-host/service.ts` serves).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";
import { LocalHostLoginPage } from "../src/pages/LocalHostLogin";
import { LocalHostSettingsPage } from "../src/pages/LocalHostSettings";
import { LocalHostUsersPage } from "../src/pages/LocalHostUsers";

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
    "/api/feature-flags": () => json({ flags: {} }),
    "/api/host/oauth2/revoke": () => json({ revoked: true }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), origin);
    const handler =
      routes[url.pathname] ??
      (url.pathname.startsWith("/api/host/users/") ? routes["/api/host/users/:id"] : undefined);
    if (!handler) return json({ message: `unexpected ${url.pathname}` }, 404);
    return handler(url.pathname, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function signIn() {
  fireEvent.change(await screen.findByLabelText("Organizer key"), {
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
    // The local shell displays local event operations and Admin-only management.
    expect(screen.getAllByText("TenkaCloud Local Competition").length).toBeGreaterThan(0);
    expect(screen.getByText("Local competition mode")).toBeInTheDocument();
    expect(screen.queryByText("Competitor accounts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to events" }));
    await waitFor(() =>
      expect(screen.queryByText("Not available in a local competition")).toBeNull(),
    );
  });

  it("returns to the host audit log after sign-in", async () => {
    const fetchMock = stubHost({
      "/api/admin/audit-log": () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={[{ pathname: "/login", state: { returnPath: "/audit-log" } }]}
        >
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    expect(await screen.findByRole("heading", { name: "監査ログ", level: 1 })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: "/api/admin/audit-log" }),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ authorization: `Bearer ${organizerToken("Admin")}` }),
        }),
      ),
    );
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
    fireEvent.click(await screen.findByRole("link", { name: "Competitor Accounts" }));
    expect(await screen.findByRole("heading", { name: "Competitor Accounts" })).toBeInTheDocument();
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

  it.each(["/users", "/identity-providers"])(
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

  it("lets an Admin change a persisted local feature flag", async () => {
    const flags = { saml: false, audit: false };
    const fetchMock = stubHost({
      "/api/feature-flags": (_url, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            key: keyof typeof flags;
            enabled: boolean;
          };
          flags[body.key] = body.enabled;
        }
        return new Response(JSON.stringify({ flags }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Local host settings" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "saml" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SAML" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) => /\/host\/(?:users|saml)/u.test(String(input))),
    ).toBe(false);
    const audit = screen.getByRole("checkbox", { name: "audit" });
    expect(audit).not.toBeChecked();
    fireEvent.click(audit);
    await waitFor(() => expect(audit).toBeChecked());
    const updateRequest = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `${origin}/api/feature-flags` && init?.method === "PUT",
    )?.[1];
    expect(JSON.parse(String(updateRequest?.body))).toEqual({ key: "audit", enabled: true });
    expect(updateRequest?.headers).toMatchObject({
      authorization: `Bearer ${organizerToken("Admin")}`,
    });
  });

  it("shows a flag loading failure instead of an empty settings page", async () => {
    const fetchMock = stubHost({
      "/api/feature-flags": () =>
        new Response(JSON.stringify({ message: "Settings could not be loaded." }), { status: 503 }),
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    expect(await screen.findByText(/Settings could not be loaded/u)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "audit" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${origin}/api/feature-flags` && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("keeps a flag off when the server rejects its change", async () => {
    const fetchMock = stubHost({
      "/api/feature-flags": (_url, init) =>
        init?.method === "PUT"
          ? new Response(JSON.stringify({ message: "Settings could not be saved." }), {
              status: 503,
            })
          : new Response(JSON.stringify({ flags: { saml: false, audit: false } })),
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    const audit = await screen.findByRole("checkbox", { name: "audit" });
    expect(audit).not.toBeChecked();
    fireEvent.click(audit);
    expect(await screen.findByText(/Settings could not be saved/u)).toBeInTheDocument();
    expect(audit).not.toBeChecked();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${origin}/api/feature-flags` && init?.method === "PUT",
      ),
    ).toBe(true);
  });

  it.each(["Operator", "Viewer"] as const)(
    "keeps direct user and settings routes read-only for %s",
    async (role) => {
      const fetchMock = stubHost({}, 8 * 60 * 60_000, role);
      const view = render(
        <I18nProvider>
          <MemoryRouter initialEntries={["/users"]}>
            <App config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await signIn();
      expect(await screen.findByText("Not available in a local competition")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
      expect(
        fetchMock.mock.calls.some(([input]) => String(input) === `${origin}/api/host/users`),
      ).toBe(false);
      view.unmount();

      render(
        <I18nProvider>
          <MemoryRouter initialEntries={["/settings"]}>
            <App config={config} />
          </MemoryRouter>
        </I18nProvider>,
      );
      await signIn();
      expect(await screen.findByText("Only Admin can change settings.")).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === `${origin}/api/feature-flags` && init?.method === "PUT",
        ),
      ).toBe(false);
    },
  );

  it("explains both protected routes in Japanese to a Viewer without loading organizer data", async () => {
    window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
    const fetchMock = stubHost({}, 8 * 60 * 60_000, "Viewer");
    const users = render(
      <I18nProvider>
        <MemoryRouter initialEntries={[{ pathname: "/login", state: { returnPath: "/users" } }]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByLabelText("主催者キー"), {
      target: { value: "synthetic-key" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("ローカル大会では使えない画面です")).toBeInTheDocument();
    users.unmount();

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={[{ pathname: "/login", state: { returnPath: "/settings" } }]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByLabelText("主催者キー"), {
      target: { value: "synthetic-key" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("設定は Admin のみ変更できます。")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === `${origin}/api/host/users`),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${origin}/api/feature-flags` && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("keeps organizer management private while no sign-in token is available", () => {
    const fetchMock = stubHost();
    const settings = render(
      <I18nProvider>
        <MemoryRouter>
          <AuthProvider config={config}>
            <LocalHostSettingsPage config={config} />
          </AuthProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText("Only Admin can change settings.")).toBeInTheDocument();
    settings.unmount();

    render(
      <I18nProvider>
        <MemoryRouter>
          <AuthProvider config={config}>
            <LocalHostUsersPage config={config} />
          </AuthProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByText("Only Admin can manage organizers.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "ignores a %s from an old host settings endpoint after the API origin changes",
    async (outcome) => {
      let settleOld!: (outcome: "success" | "failure") => void;
      const oldResponse = new Promise<Response>((resolve, reject) => {
        settleOld = (result) => {
          if (result === "failure") reject(new Error("Old host unavailable."));
          else resolve(new Response(JSON.stringify({ flags: { saml: false, audit: false } })));
        };
      });
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const pathname = new URL(String(input), origin).pathname;
        if (pathname.endsWith("/host/saml/provider"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                provider: null,
                entityId: `${origin}/api/host/saml/metadata`,
                callbackUrl: `${origin}/api/host/saml/acs`,
                identities: [],
              }),
            ),
          );
        if (pathname.endsWith("/host/users"))
          return Promise.resolve(new Response(JSON.stringify({ items: [] })));
        if (pathname === "/api/feature-flags") return oldResponse;
        if (pathname === "/api-next/feature-flags")
          return Promise.resolve(
            new Response(JSON.stringify({ flags: { saml: false, audit: true } })),
          );
        throw new Error(`Unexpected request to ${pathname}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const settings = (pageConfig: AppConfig) => (
        <I18nProvider>
          <MemoryRouter>
            <AuthProvider config={pageConfig}>
              <SignedInSettings config={pageConfig} />
            </AuthProvider>
          </MemoryRouter>
        </I18nProvider>
      );
      const view = render(settings(config));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/feature-flags")),
        ).toBe(true),
      );
      view.rerender(settings({ ...config, apiBaseUrl: `${origin}/api-next` }));
      expect(await screen.findByRole("checkbox", { name: "audit" })).toBeChecked();
      await act(async () => settleOld(outcome));
      expect(screen.getByRole("checkbox", { name: "audit" })).toBeChecked();
      expect(screen.queryByText("Old host unavailable.")).toBeNull();
    },
  );
});

function SignedInSettings({ config: pageConfig }: { config: AppConfig }) {
  const { tokens, setTokens } = useAuth();
  useEffect(() => {
    if (!tokens)
      setTokens({
        idToken: organizerToken("Admin"),
        accessToken: organizerToken("Admin"),
        expiresAt: Date.now() + 60_000,
      });
  }, [tokens, setTokens]);
  return tokens ? <LocalHostSettingsPage config={pageConfig} /> : null;
}

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
