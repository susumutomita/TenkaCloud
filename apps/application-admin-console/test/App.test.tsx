import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "テスト事業部",
  apiBaseUrl: "https://api.example.com/prod",
};

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App config={config} />
    </MemoryRouter>,
  );
}

describe("App", () => {
  afterEach(() => sessionStorage.clear());

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
    function loginAndRender() {
      sessionStorage.setItem(
        "TenkaCloud.tokens",
        JSON.stringify({ idToken: "id", accessToken: "ac", expiresAt: Date.now() + 60_000 }),
      );
      renderApp("/");
    }

    it("HomePage の H2 に config.tenantName を含む挨拶を表示すべき", async () => {
      loginAndRender();
      expect(
        await screen.findByRole("heading", { level: 2, name: `Hello, ${config.tenantName}.` }),
      ).toBeInTheDocument();
    });

    it("HomePage に「アプリを公開する」ボタン (primary) を表示すべき", async () => {
      loginAndRender();
      expect(await screen.findByRole("button", { name: "アプリを公開する" })).toBeInTheDocument();
    });

    it("システム内部 ID の tenantId は画面に直接表示しないべき", async () => {
      loginAndRender();
      // tenantName は表示されるが、tenantId (例: "tenant-test") は画面のどこにも出てはならない
      expect(await screen.findByText(`Hello, ${config.tenantName}.`)).toBeInTheDocument();
      expect(screen.queryByText(config.tenantId)).toBeNull();
    });
  });
});
