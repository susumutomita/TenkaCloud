import { describe, expect, it } from "vitest";
import { allRoutes } from "@/lib/routes";
import { searchIndex } from "@/lib/search";
import { DOC_PAGES, DOC_SECTIONS, findDocBySlug } from "./docs-registry";

const FIRST_PACK_SLUG = "tutorials/first-pack";
const FIRST_PACK_HREF = "/developers/docs/tutorials/first-pack/";

describe("docs registry — first pack tutorial", () => {
  it("should register the first pack tutorial page", () => {
    const page = findDocBySlug(FIRST_PACK_SLUG);
    expect(page).toBeDefined();
    expect(page?.href).toBe(FIRST_PACK_HREF);
  });

  it("should surface the tutorial in its own sidebar section", () => {
    const section = DOC_SECTIONS.find((s) => s.title === "Tutorials");
    expect(section).toBeDefined();
    expect(section?.pages.some((p) => p.slug === FIRST_PACK_SLUG)).toBe(true);
  });

  it("should expose the tutorial href as a known internal route", () => {
    expect(allRoutes()).toContain(FIRST_PACK_HREF);
  });

  it("should make the tutorial findable by a CLI term in search", () => {
    const results = searchIndex("pack activate");
    expect(results.some((r) => r.href.startsWith(FIRST_PACK_HREF))).toBe(true);
  });

  it("should make the tutorial findable by a diagnostic code in search", () => {
    const results = searchIndex("MANIFEST_INVALID");
    expect(results.some((r) => r.href.startsWith(FIRST_PACK_HREF))).toBe(true);
  });

  it("should keep every tutorial page maturity within the shared vocabulary", () => {
    for (const page of DOC_PAGES) {
      expect(["stable", "preview", "planned"]).toContain(page.maturity);
    }
  });
});

describe("docs registry — operator + architecture pages (#2169)", () => {
  const OPERATE_PAGES = [
    "/developers/docs/operate/deploy-paths/",
    "/developers/docs/operate/run-an-event/",
  ];
  const ARCHITECTURE_HREF = "/developers/docs/concepts/architecture/";

  it("should register the architecture and both operate pages as known routes", () => {
    const routes = allRoutes();
    expect(routes).toContain(ARCHITECTURE_HREF);
    for (const href of OPERATE_PAGES) expect(routes).toContain(href);
  });

  it("should group the operate pages under their own sidebar section", () => {
    const section = DOC_SECTIONS.find((s) => s.title === "Operate");
    expect(section).toBeDefined();
    expect(section?.pages.map((p) => p.href).sort()).toEqual([...OPERATE_PAGES].sort());
  });

  it("should place the architecture page in the Concepts section", () => {
    const section = DOC_SECTIONS.find((s) => s.title === "Concepts");
    expect(section?.pages.some((p) => p.href === ARCHITECTURE_HREF)).toBe(true);
  });

  it("should find the deploy-paths page by a pipeline term in search", () => {
    const results = searchIndex("CodePipeline tenant rollout");
    expect(results.some((r) => r.href === "/developers/docs/operate/deploy-paths/")).toBe(true);
  });

  it("should find the run-an-event page by a competitor-onboarding term in search", () => {
    const results = searchIndex("competitor account ExternalId");
    expect(results.some((r) => r.href === "/developers/docs/operate/run-an-event/")).toBe(true);
  });

  it("should find the architecture page by a Japanese search term", () => {
    const results = searchIndex("アーキテクチャ プレーン");
    expect(results.some((r) => r.href === ARCHITECTURE_HREF)).toBe(true);
  });
});
