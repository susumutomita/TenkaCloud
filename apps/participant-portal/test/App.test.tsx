import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { I18nProvider } from "../src/i18n";

const config: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (test)",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
};

function renderApp(initialPath: string) {
  // i18n Phase 1.A: main.tsx で I18nProvider が App を包むので test でも wrap する。
  // Phase 2: jsdom の navigator.language = "en-US" だと auto-detect で en に
  // なってしまい test で参照する日本語 string と乖離するため、 ja を明示 pin する。
  localStorage.setItem("tenkacloud.portal.locale", "ja");
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <App config={config} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("App", () => {
  // 1 つの test 内で auth.login が走ると localStorage に session が残るため、
  // 別 test (= 新規 render) でも redirect 挙動が引き継がれてしまう。各 test 後に
  // 明示的にクリアする (Issue #495 で localStorage 化したのに合わせた追加掃除)。
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe("/login にアクセスしたとき", () => {
    it("LoginPage が表示されサインインボタンを持つべき", async () => {
      renderApp("/login");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("未認証で / にアクセスしたとき", () => {
    it("LoginPage へ redirect されるべき", async () => {
      renderApp("/");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("チームログインキー入力 → サインイン", () => {
    it("空のキーではサインインボタンは disable されているべき", async () => {
      renderApp("/login");
      const button = await screen.findByRole("button", { name: "サインイン" });
      expect(button).toBeDisabled();
    });

    it("非空のキーを入れて submit すると Home (Welcome) に遷移するべき", async () => {
      const user = userEvent.setup();
      renderApp("/login");

      const input = screen.getByPlaceholderText("チームに配布されたキー");
      await user.type(input, "ABCDEF1234");

      const button = await screen.findByRole("button", { name: "サインイン" });
      expect(button).not.toBeDisabled();
      await user.click(button);

      // Home page の greeting (ja: 「ようこそ、{teamName} さん」) が出る
      expect(
        await screen.findByRole("heading", { level: 1, name: /ようこそ/ }),
      ).toBeInTheDocument();
    });
  });

  describe("既ログイン状態で /login に再アクセスしたとき (Issue #496)", () => {
    it("Home に redirect されサインイン画面は表示されないべき (= 黙々 team 切替の防止)", async () => {
      const user = userEvent.setup();
      // 1 度ログインして session を作る
      const { unmount } = renderApp("/login");
      const input = screen.getByPlaceholderText("チームに配布されたキー");
      await user.type(input, "TEAM-A-KEY");
      await user.click(await screen.findByRole("button", { name: "サインイン" }));
      await screen.findByRole("heading", { level: 1, name: /ようこそ/ });
      unmount();

      // session が localStorage に残ったまま /login に直接アクセスしても
      // login form は出ず、Home (Welcome) にすぐ遷移するべき
      renderApp("/login");
      expect(
        await screen.findByRole("heading", { level: 1, name: /ようこそ/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "サインイン" })).not.toBeInTheDocument();
    });
  });
});
