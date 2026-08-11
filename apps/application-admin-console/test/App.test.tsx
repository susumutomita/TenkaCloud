import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";

// The /login routes auto-redirect to Cognito via beginLogin (#1360). With the real
// beginLogin jsdom raises "Not implemented: navigation", and under the full suite that
// stray error can land on an unrelated test. Stub it to a no-op resolve — these tests
// only assert routing (that /login renders the LoginPage), not the actual redirect.
vi.mock("@tenkacloud/auth-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, beginLogin: vi.fn().mockResolvedValue(undefined) };
});

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Shared Pooled Tenant", // ← intentionally placeholder; runtime should not display this
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

function makeIdToken(claims: Record<string, string>): string {
  // 日本語を含む claims を UTF-8 base64url で吐く (Cognito JWT 互換)。
  const encode = (obj: object): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

/**
 * Tokens are memory-only, so a test can no longer fake a session by writing to
 * sessionStorage. Instead drive the real Cognito callback: seed the PKCE artifacts, stub the
 * token exchange to return an id_token carrying the given claims, and render at /callback so
 * the app exchanges → keeps the token in memory → navigates to the authenticated home.
 */
function stubLoginExchange(claims: Record<string, string>) {
  sessionStorage.setItem("TenkaCloud.pkce_verifier", "test-verifier");
  sessionStorage.setItem("TenkaCloud.oauth_state", "test-state");
  const idToken = makeIdToken(claims);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({ id_token: idToken, access_token: "ac", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

const CALLBACK_PATH = "/callback?code=test-code&state=test-state";

function renderApp(initialPath: string, appConfig: AppConfig = config) {
  // i18n Phase 1.C: main.tsx で I18nProvider が App を包むので test でも wrap する。
  // Phase 2: jsdom の navigator.language = "en-US" だと auto-detect で en が走り、
  // test 内の日本語 string と乖離するため ja を明示 pin する。
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <App config={appConfig} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("App", () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  describe("when accessing /login directly", () => {
    it("should render LoginPage", async () => {
      // Issue #1360: SAML 候補が無いので login page は中間 button を出さず Cognito へ
      // 自動 redirect する。 LoginPage が mount された印として heading を確認する。
      renderApp("/login");
      expect(
        await screen.findByRole("heading", {
          level: 2,
          name: /TenkaCloud Application Admin Console/,
        }),
      ).toBeInTheDocument();
    });
  });

  describe("when accessing / unauthenticated", () => {
    it("should redirect to LoginPage", async () => {
      // Issue #1360: 同上 — sign-in button は出ず、 LoginPage 自動 redirect で spinner が出る。
      renderApp("/");
      expect(
        await screen.findByRole("heading", {
          level: 2,
          name: /TenkaCloud Application Admin Console/,
        }),
      ).toBeInTheDocument();
    });

    it("should remember a deep link before redirecting through the login page", async () => {
      renderApp("/deployments/job-1?view=logs#latest");
      await screen.findByRole("heading", {
        level: 2,
        name: /TenkaCloud Application Admin Console/,
      });
      expect(sessionStorage.getItem("TenkaCloud.application_admin.login_return_path")).toBe(
        "/deployments/job-1?view=logs#latest",
      );
    });
  });

  describe("when completing the Cognito callback with a valid in-memory token", () => {
    it("should display JWT custom:tenantName in the greeting", async () => {
      stubLoginExchange({
        email: "admin@example.com",
        "custom:tenantId": "t-acme",
        "custom:tenantName": "ACME 株式会社",
        "custom:tenantTier": "BASIC",
      });
      renderApp(CALLBACK_PATH);
      expect(
        await screen.findByRole("heading", { level: 1, name: /ACME 株式会社 さん/ }),
      ).toBeInTheDocument();
    });

    it("should use the fallback placeholder when custom:tenantName is missing (= do not show a UUID-like tenantId in the welcome, Issue #830)", async () => {
      stubLoginExchange({
        email: "admin@example.com",
        "custom:tenantId": "3f01a734-9652-4065-a391-fa1b4d45ae26",
        "custom:tenantTier": "BASIC",
      });
      renderApp(CALLBACK_PATH);
      // welcome 文に UUID が漏れず、 fallback (= "テナント") に倒れる
      expect(
        await screen.findByRole("heading", { level: 1, name: /テナント さん/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /3f01a734/ })).toBeNull();
      // tenantName 欠落の Alert が表示される (= operator に再ログインを促す)
      expect(screen.getByText(/テナント名が JWT に含まれていません/)).toBeInTheDocument();
    });

    it("should NOT show the config.tenantName placeholder ('Shared Pooled Tenant') on screen", async () => {
      stubLoginExchange({
        email: "admin@example.com",
        "custom:tenantId": "t-acme",
        "custom:tenantName": "ACME 株式会社",
      });
      renderApp(CALLBACK_PATH);
      // tenantName 表示が完了するまで待つ
      await screen.findByRole("heading", { level: 1, name: /ACME 株式会社/ });
      expect(screen.queryByText(/Shared Pooled Tenant/)).toBeNull();
    });
  });
});
