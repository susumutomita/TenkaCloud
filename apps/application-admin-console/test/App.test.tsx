import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";

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

function loginAs(claims: Record<string, string>) {
  const idToken = makeIdToken(claims);
  sessionStorage.setItem(
    "TenkaCloud.tokens",
    JSON.stringify({ idToken, accessToken: "ac", expiresAt: Date.now() + 60_000 }),
  );
}

function renderApp(initialPath: string) {
  // i18n Phase 1.C: main.tsx で I18nProvider が App を包むので test でも wrap する。
  // Phase 2: jsdom の navigator.language = "en-US" だと auto-detect で en が走り、
  // test 内の日本語 string と乖離するため ja を明示 pin する。
  localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <App config={config} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("App", () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  describe("when accessing /login directly", () => {
    it("should render LoginPage", async () => {
      // Issue #1360: SAML 候補が無いので login page は中間 button を出さず Cognito へ
      // 自動 redirect する。 LoginPage が mount された印として heading を確認する。
      renderApp("/login");
      expect(
        await screen.findByRole("heading", {
          level: 1,
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
          level: 1,
          name: /TenkaCloud Application Admin Console/,
        }),
      ).toBeInTheDocument();
    });
  });

  describe("when accessing / with a valid token in sessionStorage", () => {
    it("should display JWT custom:tenantName in the greeting", async () => {
      loginAs({
        email: "admin@example.com",
        "custom:tenantId": "t-acme",
        "custom:tenantName": "ACME 株式会社",
        "custom:tenantTier": "BASIC",
      });
      renderApp("/");
      expect(
        await screen.findByRole("heading", { level: 1, name: /ACME 株式会社 さん/ }),
      ).toBeInTheDocument();
    });

    it("should use the fallback placeholder when custom:tenantName is missing (= do not show a UUID-like tenantId in the welcome, Issue #830)", async () => {
      loginAs({
        email: "admin@example.com",
        "custom:tenantId": "3f01a734-9652-4065-a391-fa1b4d45ae26",
        "custom:tenantTier": "BASIC",
      });
      renderApp("/");
      // welcome 文に UUID が漏れず、 fallback (= "テナント") に倒れる
      expect(
        await screen.findByRole("heading", { level: 1, name: /テナント さん/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /3f01a734/ })).toBeNull();
      // tenantName 欠落の Alert が表示される (= operator に再ログインを促す)
      expect(screen.getByText(/テナント名が JWT に含まれていません/)).toBeInTheDocument();
    });

    it("should NOT show the config.tenantName placeholder ('Shared Pooled Tenant') on screen", async () => {
      loginAs({
        email: "admin@example.com",
        "custom:tenantId": "t-acme",
        "custom:tenantName": "ACME 株式会社",
      });
      renderApp("/");
      // tenantName 表示が完了するまで待つ
      await screen.findByRole("heading", { level: 1, name: /ACME 株式会社/ });
      expect(screen.queryByText(/Shared Pooled Tenant/)).toBeNull();
    });
  });
});
