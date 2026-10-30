import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import {
  FoundationGames,
  foundationGameHref,
  practiceHref,
  practiceTheme,
} from "./Quests.foundation-games";

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
      expect(links).toHaveLength(4);
      expect(links[0]).toHaveAttribute("href", `/mail-detective/?lang=${lang}`);
      expect(links[1]).toHaveAttribute("href", `/cloud-master/?lang=${lang}`);
      expect(
        screen.getByText(
          lang === "ja" ? /公開カタログの実践例/ : /examples from the public catalog/,
        ),
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
  expect(screen.getByText("Explore a theme, then put it into practice.")).toBeInTheDocument();
  expect(screen.getAllByRole("link")[0]).toHaveAttribute("href", "/mail-detective/?lang=en");
});

it("connects only public ready practice to real demo jobs, without inventing draft or cloud support", () => {
  localStorage.setItem("tenkacloud.portal.locale", "ja");
  const catalog = [
    {
      id: "security-hype-lp",
      name: "Draft social practice",
      status: "draft",
      visibility: "public",
      tags: ["social-engineering"],
      runtime: { provider: "docker" },
    },
    {
      id: "stackstack",
      name: "Cloud practice",
      status: "ready",
      visibility: "public",
      tags: ["platform-engineering"],
      runtime: { provider: "aws" },
    },
    {
      id: "xss-demo",
      name: "Local web practice",
      status: "ready",
      visibility: "public",
      tags: ["web-security"],
      runtime: { provider: "docker" },
    },
    {
      id: "private",
      name: "Hidden practice",
      status: "ready",
      visibility: "private",
      tags: [],
      runtime: { provider: "aws" },
    },
  ] as unknown as import("@tenkacloud/portal-contracts").ProblemCatalogEntry[];
  const problems = [
    { problemId: "stackstack", jobId: "actual/cloud" },
    { problemId: "xss-demo", jobId: "actual-local" },
  ] as import("@tenkacloud/portal-contracts").ParticipantProblemView[];
  render(
    <AppConfigProvider config={config}>
      <I18nProvider>
        <FoundationGames catalog={catalog} problems={problems} />
      </I18nProvider>
    </AppConfigProvider>,
  );
  expect(screen.queryByText("Draft social practice")).not.toBeInTheDocument();
  expect(screen.queryByText("Hidden practice")).not.toBeInTheDocument();
  expect(screen.getByText("Cloud practice")).toBeInTheDocument();
  expect(screen.getByText("Local web practice")).toBeInTheDocument();
  const links = screen.getAllByRole("link");
  expect(links.some((link) => link.getAttribute("href") === "/problems/actual%2Fcloud")).toBe(true);
  expect(links.some((link) => link.getAttribute("href") === "/problems/actual-local")).toBe(true);
  expect(screen.getByText(/ローカル開催専用/)).toBeInTheDocument();
  expect(screen.getByText(/クラウド開催専用/)).toBeInTheDocument();
});

it("keeps semantic themes independent of runtime and preserves deployment prefix", () => {
  expect(practiceTheme({ tags: ["social-engineering", "aws"] })).toBe("social");
  expect(practiceTheme({ tags: ["web-security"] })).toBe("web");
  expect(practiceTheme({ tags: ["platform-engineering"] })).toBe("cloud");
  expect(practiceTheme({ tags: ["memory-safety"] })).toBeNull();
  expect(practiceHref("/TenkaCloud/portal-demo/", "actual/cloud")).toBe(
    "/TenkaCloud/portal-demo/problems/actual%2Fcloud",
  );
});
