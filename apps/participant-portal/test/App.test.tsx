import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { AppConfigProvider } from "../src/config-context";
import { I18nProvider } from "../src/i18n";

const config: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (test)",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
  cloudMode: "mock",
};

function renderApp(initialPath: string) {
  // i18n Phase 1.A: main.tsx で I18nProvider が App を包むので test でも wrap する。
  // Phase 2: jsdom の navigator.language = "en-US" だと auto-detect で en に
  // なってしまい test で参照する日本語 string と乖離するため、 ja を明示 pin する。
  localStorage.setItem("tenkacloud.portal.locale", "ja");
  return render(
    <I18nProvider>
      <AppConfigProvider config={config}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App config={config} />
        </MemoryRouter>
      </AppConfigProvider>
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

  describe("when accessing /login", () => {
    it("should render LoginPage with a sign-in button", async () => {
      renderApp("/login");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("when accessing / while unauthenticated", () => {
    it("should redirect to LoginPage", async () => {
      renderApp("/");
      expect(await screen.findByRole("button", { name: "サインイン" })).toBeInTheDocument();
    });
  });

  describe("team login key input -> sign-in", () => {
    it("should disable the sign-in button when the key is empty", async () => {
      renderApp("/login");
      const button = await screen.findByRole("button", { name: "サインイン" });
      expect(button).toBeDisabled();
    });

    it("should navigate to Home (Welcome) when submitting a non-empty key", async () => {
      const user = userEvent.setup();
      renderApp("/login");

      const input = screen.getByPlaceholderText("例: demo (何でも OK)");
      await user.type(input, "ABCDEF1234");

      const button = await screen.findByRole("button", { name: "サインイン" });
      expect(button).not.toBeDisabled();
      await user.click(button);

      // Home page の greeting (ja: 「ようこそ、{teamName} さん」) が出る
      expect(
        await screen.findByRole("heading", { level: 1, name: /ようこそ/ }),
      ).toBeInTheDocument();
      expect(screen.getByText(/実際の AWS リソースや料金は発生しません/)).toBeInTheDocument();
    });
  });

  describe("when re-accessing /login while already logged in (Issue #496)", () => {
    it("should redirect to Home and not show the sign-in screen (= prevent silent team switching)", async () => {
      const user = userEvent.setup();
      // 1 度ログインして session を作る
      const { unmount } = renderApp("/login");
      const input = screen.getByPlaceholderText("例: demo (何でも OK)");
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
