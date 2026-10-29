import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { FoundationGames, foundationGameHref } from "./Quests.foundation-games";

const config = {
  apiBaseUrl: "",
  mode: "dev-mock" as const,
  cloudMode: "mock" as const,
  eventRegion: "ap-northeast-1",
  eventTitle: "Demo",
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
function renderGames(
  lang = "ja",
  overrides: { mode?: "backend"; cloudMode?: "real" | "local" } = {},
) {
  localStorage.setItem("tenkacloud.portal.locale", lang);
  return render(
    <AppConfigProvider config={{ ...config, ...overrides }}>
      <I18nProvider>
        <FoundationGames />
      </I18nProvider>
    </AppConfigProvider>,
  );
}
describe("demo foundation game links", () => {
  it.each(["ja", "en"])(
    "renders separate browser game links in %s without catalog or scoring calls",
    (lang) => {
      renderGames(lang);
      expect(screen.getByTestId("foundation-games")).toBeInTheDocument();
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute("href", `/mail-detective/?lang=${lang}`);
      expect(links[1]).toHaveAttribute("href", `/cloud-master/?lang=${lang}`);
      expect(
        screen.getByText(lang === "ja" ? /大会の得点には/ : /do not count toward event/),
      ).toBeInTheDocument();
    },
  );
  it("preserves a GitHub Pages deployment prefix and never resolves inside the problems route", () => {
    expect(foundationGameHref("/TenkaCloud/portal-demo/", "mail-detective", "ja")).toBe(
      "/TenkaCloud/mail-detective/?lang=ja",
    );
    expect(foundationGameHref("/portal-demo/", "cloud-master", "en")).toBe(
      "/cloud-master/?lang=en",
    );
  });
  it.each([
    { mode: "backend" as const },
    { cloudMode: "real" as const },
    { cloudMode: "local" as const },
  ])("does not advertise static games in real/local event configuration %j", (overrides) => {
    renderGames("ja", overrides);
    expect(screen.queryByTestId("foundation-games")).not.toBeInTheDocument();
  });
});

it("uses the explicit shared-list language on a fresh demo visit", () => {
  window.history.replaceState(null, "", "/portal-demo/problems?lang=en");
  renderGames("ja");
  expect(screen.getByText("Quick foundation games")).toBeInTheDocument();
  expect(screen.getAllByRole("link")[0]).toHaveAttribute("href", "/mail-detective/?lang=en");
});
