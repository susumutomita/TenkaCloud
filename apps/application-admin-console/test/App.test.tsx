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

  describe("/login に直接アクセスしたとき", () => {
    it("LoginPage が表示されサインインボタンを持つべき", async () => {
      renderApp("/login");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("未認証で / にアクセスしたとき", () => {
    it("LoginPage へ redirect され、サインインボタンが表示されるべき", async () => {
      renderApp("/");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("有効な token を sessionStorage に持って / にアクセスしたとき", () => {
    it("JWT custom:tenantName を greeting に表示すべき", async () => {
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

    it("custom:tenantName が無いときは fallback プレースホルダ (= UUID-like tenantId を welcome に出さない、 Issue #830)", async () => {
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

    it("config.tenantName の placeholder ('Shared Pooled Tenant') を画面に出してはいけない", async () => {
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
