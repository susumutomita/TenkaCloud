/**
 * Issue #3226: the organizer's journey through the normal console in local-host mode, against
 * a stubbed host API (the same wire shapes `scripts/local-host/service.ts` serves).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    "/api/host/bootstrap-status": () => json({ bootstrapCompleted: true }),
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
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "organizer-password" } });
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
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByLabelText("Host key")).toBeNull();
  });

  it("lets an Admin add, disable, and remove local organizers through the users page", async () => {
    const users = [{ id: "owner-id", username: "owner", role: "Admin", status: "active" }];
    const secret = "operator-password";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const fetchMock = stubHost({
      "/api/host/users": (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { username: string; role: OrganizerRole };
          users.push({
            id: `${body.username}-id`,
            username: body.username,
            role: body.role,
            status: "active",
          });
        }
        return json({ items: users });
      },
      "/api/host/users/:id": (url, init) => {
        const id = url.split("/").at(-1);
        const index = users.findIndex((user) => user.id === id);
        if (index < 0) return new Response("{}", { status: 404 });
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            role: OrganizerRole;
            status: "active" | "disabled";
          };
          users[index] = { ...users[index], ...body };
        }
        if (init?.method === "DELETE") users.splice(index, 1);
        return json({ items: users });
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Users" }));
    expect(await screen.findByRole("heading", { name: "Organizer users" })).toBeInTheDocument();
    expect(screen.getByText("owner").closest("li")).toHaveTextContent("Admin · active");

    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), {
      target: { value: "operator" },
    });
    fireEvent.change(screen.getByLabelText("Password (at least 12 characters)"), {
      target: { value: "short" },
    });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Password (at least 12 characters)"), {
      target: { value: secret },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "New user role" }), {
      target: { value: "Operator" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(screen.getByText("operator").closest("li")).toHaveTextContent("Operator · active"),
    );
    const createRequest = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `${origin}/api/host/users` && init?.method === "POST",
    )?.[1];
    expect(JSON.parse(String(createRequest?.body))).toEqual({
      username: "operator",
      password: secret,
      role: "Operator",
    });
    expect(createRequest?.headers).toMatchObject({
      authorization: `Bearer ${organizerToken("Admin")}`,
    });

    const operatorRow = screen.getByText("operator").closest("li") as HTMLLIElement;
    fireEvent.click(within(operatorRow).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "disabled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("operator").closest("li")).toHaveTextContent("Operator · disabled"),
    );
    const updateRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === `${origin}/api/host/users/operator-id` && init?.method === "PATCH",
    )?.[1];
    expect(JSON.parse(String(updateRequest?.body))).toEqual({
      role: "Operator",
      status: "disabled",
    });

    fireEvent.click(
      within(screen.getByText("operator").closest("li") as HTMLLIElement).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(screen.queryByText("operator")).toBeNull());
    expect(window.confirm).toHaveBeenCalledWith("Delete operator?");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${origin}/api/host/users/operator-id` && init?.method === "DELETE",
      ),
    ).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), {
      target: { value: "viewer" },
    });
    fireEvent.change(screen.getByLabelText("Password (at least 12 characters)"), {
      target: { value: secret },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "New user role" }), {
      target: { value: "Viewer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(screen.getByText("viewer").closest("li")).toHaveTextContent("Viewer · active"),
    );
    const viewerRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === `${origin}/api/host/users` &&
        init?.method === "POST" &&
        String(init.body).includes("viewer"),
    )?.[1];
    expect(JSON.parse(String(viewerRequest?.body))).toEqual({
      username: "viewer",
      password: secret,
      role: "Viewer",
    });
  });

  it("lets a Japanese Admin change an organizer password and a host flag without losing the saved state", async () => {
    window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
    const replacement = "replacement-password";
    const users = [{ id: "owner-id", username: "owner", role: "Admin", status: "active" }];
    const flags = { saml: false, audit: false };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const fetchMock = stubHost({
      "/api/host/users": (_url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { username: string; role: OrganizerRole };
          users.push({
            id: `${body.username}-id`,
            username: body.username,
            role: body.role,
            status: "active",
          });
        }
        return json({ items: users });
      },
      "/api/host/users/:id": (url, init) => {
        const index = users.findIndex((user) => user.id === url.split("/").at(-1));
        if (index < 0) return new Response("{}", { status: 404 });
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            role: OrganizerRole;
            status: "active" | "disabled";
          };
          users[index] = { ...users[index], ...body };
        }
        if (init?.method === "DELETE") users.splice(index, 1);
        return json({ items: users });
      },
      "/api/feature-flags": (_url, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            key: keyof typeof flags;
            enabled: boolean;
          };
          flags[body.key] = body.enabled;
        }
        return json({ flags });
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={[{ pathname: "/login", state: { returnPath: "/users" } }]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByLabelText("ユーザー名"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "organizer-password" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByRole("heading", { name: "主催者ユーザー" })).toBeInTheDocument();
    expect(screen.getByText(/最後の有効な Admin は変更・削除できません/u)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "ユーザー名" }), {
      target: { value: "helper" },
    });
    fireEvent.change(screen.getByLabelText("パスワード（12文字以上）"), {
      target: { value: "initial-password" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "新しいユーザーの権限" }), {
      target: { value: "Operator" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() =>
      expect(screen.getByText("helper").closest("li")).toHaveTextContent("Operator · active"),
    );
    const helper = screen.getByText("helper").closest("li") as HTMLLIElement;
    fireEvent.click(within(helper).getByRole("button", { name: "編集" }));
    expect(screen.getByRole("heading", { name: "ユーザーを編集: helper" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "状態" }), {
      target: { value: "disabled" },
    });
    fireEvent.change(screen.getByLabelText("新しいパスワード（変更時のみ）"), {
      target: { value: replacement },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(screen.getByText("helper").closest("li")).toHaveTextContent("Operator · disabled"),
    );
    const passwordChange = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === `${origin}/api/host/users/helper-id` && init?.method === "PATCH",
    )?.[1];
    expect(JSON.parse(String(passwordChange?.body))).toEqual({
      role: "Operator",
      status: "disabled",
      password: replacement,
    });
    fireEvent.click(within(helper).getByRole("button", { name: "削除" }));
    expect(confirm).toHaveBeenCalledWith("helper を削除しますか？");
    expect(screen.getByText("helper")).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(within(helper).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(screen.queryByText("helper")).toBeNull());

    fireEvent.click(screen.getByRole("link", { name: "設定" }));
    expect(await screen.findByRole("heading", { name: "ローカルホスト設定" })).toBeInTheDocument();
    expect(screen.getByText(/機能フラグは SQLite に保存されます/u)).toBeInTheDocument();
    const audit = await screen.findByRole("checkbox", { name: "audit" });
    fireEvent.click(audit);
    await waitFor(() => expect(audit).toBeChecked());
    expect(flags.audit).toBe(true);
  });

  it("keeps the last Admin visible when user changes are rejected", async () => {
    const secret = "replacement-password";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = stubHost({
      "/api/host/users": (_url, init) =>
        init?.method === "POST"
          ? json({ message: "Username already exists." }, 409)
          : json({
              items: [{ id: "owner-id", username: "owner", role: "Admin", status: "active" }],
            }),
      "/api/host/users/:id": () =>
        json({ message: "At least one active local-password Admin is required." }, 409),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Users" }));
    const owner = await screen.findByText("owner");

    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Password (at least 12 characters)"), {
      target: { value: secret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/Username already exists/u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Username" })).toHaveValue("owner");

    fireEvent.click(
      within(owner.closest("li") as HTMLLIElement).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), {
      target: { value: "Viewer" },
    });
    fireEvent.change(screen.getByLabelText("New password (only to change)"), {
      target: { value: secret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/At least one active local-password Admin is required/u),
    ).toBeInTheDocument();
    const updateRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === `${origin}/api/host/users/owner-id` && init?.method === "PATCH",
    )?.[1];
    expect(JSON.parse(String(updateRequest?.body))).toEqual({
      role: "Viewer",
      status: "active",
      password: secret,
    });
    expect(screen.getByText("owner").closest("li")).toHaveTextContent("Admin · active");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: /Edit user/u })).toBeNull();

    fireEvent.click(
      within(owner.closest("li") as HTMLLIElement).getByRole("button", { name: "Delete" }),
    );
    expect(confirm).toHaveBeenCalledWith("Delete owner?");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `${origin}/api/host/users/owner-id` && init?.method === "DELETE",
      ),
    ).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(
      within(owner.closest("li") as HTMLLIElement).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === `${origin}/api/host/users/owner-id` && init?.method === "DELETE",
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/At least one active local-password Admin is required/u),
    ).toBeInTheDocument();
    expect(screen.getByText("owner").closest("li")).toHaveTextContent("Admin · active");
  });

  it("shows a user-list loading failure without claiming the list is empty", async () => {
    stubHost({
      "/api/host/users": () =>
        new Response(JSON.stringify({ message: "Organizer database unavailable." }), {
          status: 503,
        }),
    });
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Users" }));
    expect(await screen.findByText(/Organizer database unavailable/u)).toBeInTheDocument();
    expect(screen.queryByText("owner")).toBeNull();
  });

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
      expect(await screen.findByText("Only Admin can manage organizers.")).toBeInTheDocument();
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
    fireEvent.change(await screen.findByLabelText("ユーザー名"), { target: { value: "viewer" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "viewer-password" } });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("ユーザー管理は Admin のみ利用できます。")).toBeInTheDocument();
    users.unmount();

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={[{ pathname: "/login", state: { returnPath: "/settings" } }]}>
          <App config={config} />
        </MemoryRouter>
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByLabelText("ユーザー名"), { target: { value: "viewer" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "viewer-password" } });
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
    await screen.findByLabelText("Username");
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/host/bootstrap-status`);
    expect(fetchMock).not.toHaveBeenCalledWith(`${origin}/api/host/login`, expect.anything());
  });

  it("shows a host-status failure before accepting credentials", async () => {
    const fetchMock = stubHost({
      "/api/host/bootstrap-status": () => new Response("{}", { status: 503 }),
    });
    renderLoginOnly();
    expect(await screen.findByRole("alert")).toHaveTextContent("Host status unavailable.");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Host key")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === `${origin}/api/host/login`),
    ).toBe(false);
  });

  it("switches the password sign-in page between Japanese and English", async () => {
    stubHost();
    renderLoginOnly();
    await screen.findByLabelText("Username");
    fireEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(screen.getByLabelText("ユーザー名")).toBeInTheDocument();
    expect(screen.getByLabelText("パスワード")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});
