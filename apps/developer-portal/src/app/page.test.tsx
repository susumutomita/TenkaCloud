import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_DISCUSSIONS } from "@/lib/links";
import { isInternalHref, isKnownRoute } from "@/lib/routes";
import EnglishHomePage from "./en/page";
import HomePage from "./page";

afterEach(cleanup);

function isResolvable(href: string): boolean {
  return isKnownRoute(href) || isKnownRoute(`${href.replace(/\/$/, "")}/`);
}

// The marketing home is the public front door of tenkacloud.com (#2408). Japanese
// renders at "/", English at "/en/", both from the one bilingual content model.
// These tests pin that the front door routes into real, resolvable portal pages
// (a dead CTA fails here, not in the browser) and that both languages ship.
describe("HomePage (Japanese, /)", () => {
  it("should render the business-first Japanese marketing hero", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("クラウド実戦力");
  });

  it("should make enterprise consultation the primary CTA", () => {
    render(<HomePage />);
    const cta = screen.getByRole("link", { name: "企業導入を GitHub で公開相談" });
    expect(cta).toHaveAttribute("href", GITHUB_DISCUSSIONS);
    expect(cta).toHaveAttribute("data-cta", "home-enterprise-contact");
  });

  it("should retain a direct path to the public catalog", () => {
    render(<HomePage />);
    const cta = screen
      .getAllByRole("link", { name: "問題カタログを見る" })
      .find((link) => link.getAttribute("data-cta") === "home-catalog");
    expect(cta).toBeDefined();
    expect(cta).toHaveAttribute("href", "/catalog/");
    expect(isKnownRoute("/catalog/")).toBe(true);
  });

  it("should offer a role-neutral documentation CTA that resolves to a known route", () => {
    render(<HomePage />);
    const cta = screen.getByRole("link", { name: "ドキュメント" });
    expect(cta).toHaveAttribute("href", "/developers/");
    expect(isKnownRoute("/developers/")).toBe(true);
  });

  it("should resolve every internal link to a known route", () => {
    render(<HomePage />);
    const internalHrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => isInternalHref(href));
    expect(internalHrefs.length).toBeGreaterThan(0);
    for (const href of internalHrefs) {
      expect(isResolvable(href)).toBe(true);
    }
  });

  it("should switch language to the English mirror", () => {
    render(<HomePage />);
    const toEnglish = screen.getByRole("link", { name: "English" });
    expect(toEnglish).toHaveAttribute("href", "/en/");
  });
});

describe("EnglishHomePage (/en/)", () => {
  it("should render the business-first English marketing hero", () => {
    render(<EnglishHomePage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("cloud skills");
  });

  it("should point the catalog CTA and language switch at the English mirrors", () => {
    render(<EnglishHomePage />);
    const cta = screen
      .getAllByRole("link", { name: "Browse the catalog" })
      .find((link) => link.getAttribute("data-cta") === "home-catalog");
    // The English home keeps the English reader on the English catalog mirror.
    expect(cta).toHaveAttribute("href", "/en/catalog/");
    // The language switch returns to the Japanese (primary) home.
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("href", "/");
  });

  it("should only send interactive traffic to GitHub externally", () => {
    render(<EnglishHomePage />);
    const externalHrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("http"));
    for (const href of externalHrefs) {
      expect(href).toMatch(/^https:\/\/github\.com\//);
    }
  });
});

describe("marketing home offerings", () => {
  it("should present the three productized offerings", () => {
    render(<HomePage />);
    // The pricing section renders each tier as an article with its name.
    for (const tier of ["Starter", "Hosted Event", "Annual Arena"]) {
      expect(screen.getAllByText(tier).length).toBeGreaterThan(0);
    }
  });

  it("should route every public pricing discussion CTA to GitHub Discussions", () => {
    render(<HomePage />);
    const discussionCtas = screen.getAllByRole("link", { name: "GitHub で公開相談" });
    expect(discussionCtas.length).toBeGreaterThan(0);
    for (const cta of discussionCtas) {
      expect(cta).toHaveAttribute("href", GITHUB_DISCUSSIONS);
    }
  });

  it("should render the security-guarantee bullet list", () => {
    const { container } = render(<HomePage />);
    // The security section renders its guarantees as list items (proves the section
    // model wired, not just the hero).
    const bullets = within(container).getAllByRole("listitem");
    expect(bullets.length).toBeGreaterThan(0);
  });
});
