import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_PACK_HREF, RUN_PACKS_HREF } from "@/lib/navigation";
import { allRoutes, isInternalHref, isKnownRoute } from "@/lib/routes";
import HomePage from "./page";

afterEach(cleanup);

// next/link normalizes away the trailing slash at render time, while the route set
// (and the build-time link checker, which reads the source href) keeps it. Compare
// slash-insensitively so the test pins intent, not Next's rendering quirk.
function samePath(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/\/$/, "");
  return strip(a) === strip(b);
}

function isResolvable(href: string): boolean {
  const routes = allRoutes();
  return isKnownRoute(href, routes) || isKnownRoute(`${href.replace(/\/$/, "")}/`, routes);
}

// The landing page is the public entry point to the developer portal (#2104).
// These tests pin the author/operator journeys to real, resolvable doc routes so a
// dead CTA — the exact failure mode the issue calls out — fails here, not in the
// browser.
describe("HomePage", () => {
  it("should land the author CTA on the first-pack tutorial, not a repository root", () => {
    render(<HomePage />);
    const cta = screen.getByRole("link", { name: "Build a problem pack" });
    expect(samePath(cta.getAttribute("href") ?? "", FIRST_PACK_HREF)).toBe(true);
    expect(FIRST_PACK_HREF).toBe("/developers/docs/tutorials/first-pack/");
    expect(isKnownRoute(FIRST_PACK_HREF)).toBe(true);
  });

  it("should offer an operator CTA that lands on the install-and-run guide", () => {
    render(<HomePage />);
    const cta = screen.getByRole("link", { name: "Install and run packs" });
    expect(samePath(cta.getAttribute("href") ?? "", RUN_PACKS_HREF)).toBe(true);
    expect(RUN_PACKS_HREF).toBe("/developers/docs/getting-started/");
    expect(isKnownRoute(RUN_PACKS_HREF)).toBe(true);
  });

  it("should resolve every internal landing-page link to a known docs route", () => {
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

  it("should not point any landing-page link at a bare repository or README page", () => {
    render(<HomePage />);
    for (const link of screen.getAllByRole("link")) {
      const href = link.getAttribute("href") ?? "";
      expect(href).not.toMatch(/github\.com|README/i);
    }
  });

  it("should distinguish the author and operator doc CTAs for navigation measurement", () => {
    render(<HomePage />);
    expect(screen.getByRole("link", { name: "Build a problem pack" })).toHaveAttribute(
      "data-cta",
      "author-build-pack",
    );
    expect(screen.getByRole("link", { name: "Install and run packs" })).toHaveAttribute(
      "data-cta",
      "operator-run-packs",
    );
  });
});
