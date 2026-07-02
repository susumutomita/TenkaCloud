import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantIdpSummary } from "../../src/api/idp-client";
import type { AppConfig } from "../../src/config";

/**
 * Issue #1294 / #1362: IdentityProvidersPage (Tenant Admin → SAML IdP CRUD)。
 * isolation gate (pooled hero) / apiBaseUrl 未設定 warning / loading / list 成功行
 * (description "—" fallback + Test sign-in href + Delete) / empty hero / load error /
 * Add modal (open / onClose / onCreated→refresh) / delete (confirm true/false / 失敗) /
 * tokens 不在で client=null を pin する。 createTenantIdpClient / describeTenantIdpError /
 * useAuth / useLang / CreateIdpModal を mock、 formatRelativeTime は実物。
 */
const { mockCreateClient, mockDescribeErr, mockUseAuth, fakeClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockDescribeErr: vi.fn(),
  mockUseAuth: vi.fn(),
  fakeClient: { list: vi.fn(), remove: vi.fn() },
}));

vi.mock("../../src/api/idp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/idp-client")>();
  return {
    ...actual,
    createTenantIdpClient: mockCreateClient,
    describeTenantIdpError: mockDescribeErr,
  };
});
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockUseAuth }));
vi.mock("../../src/i18n", async () => {
  const en = (await import("../../src/i18n/locales/en.json")).default as Record<string, unknown>;
  const resolve = (key: string): string => {
    const v = key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        en,
      );
    return typeof v === "string" ? v : key;
  };
  return {
    useLang: () => "en",
    useT: () => (key: string, params?: Record<string, string | number>) => {
      let s = resolve(key);
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
  };
});
vi.mock("../../src/pages/CreateIdpModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  CreateIdpModal: ({ cognitoDomain, onClose, onCreated }: any) => (
    <div data-testid="create-modal" data-cognito-domain={cognitoDomain}>
      <button type="button" onClick={onClose}>
        stub-close
      </button>
      <button type="button" onClick={onCreated}>
        stub-created
      </button>
    </div>
  ),
}));

const { IdentityProvidersPage } = await import("../../src/pages/IdentityProviders");

function b64url(value: object): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload: object): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

const adminToken = makeJwt({
  iss: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example",
  "custom:userRole": "TenantAdmin",
});
const viewerToken = makeJwt({
  iss: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example",
  "custom:userRole": "TenantViewer",
});

const config = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    cognitoDomain: "auth.example.com",
    cognitoClientId: "cid",
    redirectUri: "https://app.example.com/cb",
    scope: "openid",
    tenantName: "Acme",
    apiBaseUrl: "https://api.example.com",
    isolation: "silo",
    features: {
      samlSso: true,
      nonAwsRuntime: false,
      redTeam: false,
      challengePrerequisiteGate: false,
    },
    ...over,
  }) as AppConfig;
const idp = (over: Partial<TenantIdpSummary> = {}): TenantIdpSummary =>
  ({
    idpId: "idp1",
    displayName: "Okta",
    description: "corp okta",
    tenantId: "t1",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...over,
  }) as TenantIdpSummary;
const renderPage = (cfg = config()) => render(<IdentityProvidersPage config={cfg} />);

beforeEach(() => {
  mockUseAuth.mockReturnValue({ tokens: { idToken: adminToken } });
  mockCreateClient.mockReturnValue(fakeClient);
  mockDescribeErr.mockImplementation((e: unknown) => (e instanceof Error ? e.message : String(e)));
  fakeClient.list.mockReset().mockResolvedValue([]);
  fakeClient.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("IdentityProvidersPage", () => {
  it("should show the feature-disabled hero (and skip fetch) when featureSamlSso is off", () => {
    renderPage(
      config({
        features: {
          samlSso: false,
          nonAwsRuntime: false,
          redTeam: false,
          challengePrerequisiteGate: false,
        },
      }),
    );
    expect(screen.getByText("Identity providers are not available")).toBeInTheDocument();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("should show the silo-only hero on a pooled tenant", () => {
    renderPage(config({ isolation: "pooled" }));
    expect(screen.getByText(/requires the silo plan/i)).toBeInTheDocument();
  });

  it("should warn when the IdP CRUD API base URL is not wired up", () => {
    renderPage(config({ apiBaseUrl: "" }));
    expect(screen.getByText("The identity-provider API is unavailable")).toBeInTheDocument();
  });

  it("should show the table loading state and skip fetch when there are no auth tokens", () => {
    mockUseAuth.mockReturnValue({ tokens: null });
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(fakeClient.list).not.toHaveBeenCalled();
  });

  it("should render IdP rows with a description fallback and a Test sign-in deep link", async () => {
    fakeClient.list.mockResolvedValue([
      idp({ idpId: "idp1", displayName: "Okta", description: "corp okta" }),
      idp({ idpId: "idp2", displayName: "Entra", description: undefined }), // → "—"
    ]);
    const { container } = renderPage();
    expect(await screen.findByText("Okta")).toBeInTheDocument();
    expect(screen.getByText("Entra")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // description fallback
    const testLink = container.querySelector<HTMLAnchorElement>(
      'a[href*="identity_provider=idp1"]',
    );
    expect(testLink).not.toBeNull();
    expect(testLink?.getAttribute("href")).toContain("auth.example.com/oauth2/authorize");
    expect(testLink?.getAttribute("href")).toContain("client_id=cid");
  });

  it("should show the empty hero when no IdPs are configured", async () => {
    fakeClient.list.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No SAML IdPs configured yet/)).toBeInTheDocument();
  });

  it("should surface a load error in an alert", async () => {
    fakeClient.list.mockRejectedValue(new Error("list forbidden"));
    renderPage();
    expect(await screen.findByText("list forbidden")).toBeInTheDocument();
  });

  it("should open the create modal, refresh on create, and close on cancel", async () => {
    fakeClient.list.mockResolvedValue([]);
    renderPage();
    await screen.findByText(/No SAML IdPs configured yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add SAML IdP" }));
    expect(screen.getByTestId("create-modal")).toBeInTheDocument();
    expect(screen.getByTestId("create-modal")).toHaveAttribute(
      "data-cognito-domain",
      "auth.example.com",
    );

    fireEvent.click(screen.getByText("stub-created"));
    await waitFor(() => expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument());
    expect(fakeClient.list).toHaveBeenCalledTimes(2); // mount + onCreated refresh

    fireEvent.click(screen.getByRole("button", { name: "Add SAML IdP" }));
    fireEvent.click(screen.getByText("stub-close"));
    expect(screen.queryByTestId("create-modal")).not.toBeInTheDocument();
  });

  it("should disable SAML mutation controls for a read-only viewer", async () => {
    mockUseAuth.mockReturnValue({ tokens: { idToken: viewerToken } });
    fakeClient.list.mockResolvedValue([idp({ idpId: "idp1" })]);
    renderPage();
    expect(await screen.findByText("Okta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add SAML IdP" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("should delete an IdP after confirmation and refresh", async () => {
    fakeClient.list.mockResolvedValue([idp({ idpId: "idp1" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fakeClient.remove).toHaveBeenCalledWith("idp1"));
    expect(fakeClient.list).toHaveBeenCalledTimes(2); // mount + post-delete refresh
    confirmSpy.mockRestore();
  });

  it("should not delete when confirmation is cancelled", async () => {
    fakeClient.list.mockResolvedValue([idp({ idpId: "idp1" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fakeClient.remove).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("should surface a delete error in an alert", async () => {
    fakeClient.list.mockResolvedValue([idp({ idpId: "idp1" })]);
    fakeClient.remove.mockRejectedValue(new Error("delete denied"));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("Okta");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("delete denied")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("should no-op delete when the client became unavailable (token expiry mid-session)", async () => {
    fakeClient.list.mockResolvedValue([idp({ idpId: "idp1" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = renderPage();
    await screen.findByText("Okta");
    // token 失効 → client=null。 items state は残るので row + Delete button は描画されたまま。
    mockUseAuth.mockReturnValue({ tokens: null });
    mockCreateClient.mockReturnValue(null);
    rerender(<IdentityProvidersPage config={config()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fakeClient.remove).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled(); // !client で confirm 前に return
    confirmSpy.mockRestore();
  });
});
