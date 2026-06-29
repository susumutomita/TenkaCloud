import { describe, expect, it } from "vitest";
import { REDIRECTS, resolveRedirect } from "./redirects";
import { allRoutes, isKnownRoute } from "./routes";

describe("legacy redirects", () => {
  it("should resolve a legacy landing route to its intended destination", () => {
    expect(resolveRedirect("/docs")).toBe("/developers/docs/getting-started/");
    expect(resolveRedirect("/get-started")).toBe("/developers/docs/getting-started/");
    expect(resolveRedirect("/api")).toBe("/developers/api/");
    expect(resolveRedirect("/changelog")).toBe("/developers/changelog/");
  });

  it("should preserve the destination regardless of a trailing slash on the legacy path", () => {
    expect(resolveRedirect("/docs/")).toBe("/developers/docs/getting-started/");
  });

  it("should return undefined for a path with no redirect rule", () => {
    expect(resolveRedirect("/not-a-legacy-route")).toBeUndefined();
  });

  it("should only redirect to routes the app actually serves (no dead redirects)", () => {
    const routes = allRoutes();
    for (const rule of REDIRECTS) {
      expect(isKnownRoute(rule.to, routes)).toBe(true);
    }
  });
});
