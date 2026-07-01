import { describe, expect, it } from "vitest";
import { buildSearchIndex, searchIndex } from "./search";

describe("search index", () => {
  it("should index docs body content so a body-only term is findable", () => {
    const results = searchIndex("participant portal");
    expect(results.some((r) => r.href.startsWith("/developers/docs/getting-started"))).toBe(true);
  });

  it("should index docs headings", () => {
    const results = searchIndex("Battle versus Challenge");
    expect(results.some((r) => r.kind === "heading")).toBe(true);
  });

  it("should index API operation names alongside docs", () => {
    const results = searchIndex("createDeployment");
    expect(results.some((r) => r.kind === "api" && r.title.includes("/deployments"))).toBe(true);
  });

  it("should return nothing for an empty query", () => {
    expect(searchIndex("")).toEqual([]);
  });

  it("should require every term to match (AND semantics)", () => {
    const index = buildSearchIndex();
    const results = searchIndex("packs zzzznotpresent", index);
    expect(results).toEqual([]);
  });
});
