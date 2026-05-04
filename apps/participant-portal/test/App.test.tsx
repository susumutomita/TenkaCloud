import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  apiBaseUrl: "http://localhost:3199/dev-mock",
  eventTitle: "TenkaCloud Battle (test)",
  eventRegion: "ap-northeast-1",
  mode: "dev-mock",
};

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App config={config} />
    </MemoryRouter>,
  );
}

describe("App", () => {
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

      // Home page の greeting が出る
      expect(
        await screen.findByRole("heading", { level: 1, name: /Welcome,/ }),
      ).toBeInTheDocument();
    });
  });
});
