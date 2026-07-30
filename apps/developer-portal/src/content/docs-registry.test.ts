import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allRoutes } from "@/lib/routes";
import { searchIndex } from "@/lib/search";
import { DOC_PAGES, DOC_SECTIONS, findDocBySlug } from "./docs-registry";

const FIRST_PACK_SLUG = "tutorials/first-pack";
const FIRST_PACK_HREF = "/developers/docs/tutorials/first-pack/";
const USE_EXISTING_PACK_SLUG = "operate/use-existing-pack";
const USE_EXISTING_PACK_HREF = "/developers/docs/operate/use-existing-pack/";

const FIRST_PACK_SOURCE = readFileSync(
  "src/app/developers/docs/tutorials/first-pack/page.mdx",
  "utf8",
);
const USE_EXISTING_PACK_SOURCE = readFileSync(
  "src/app/developers/docs/operate/use-existing-pack/page.mdx",
  "utf8",
);
const ROLE_MANUAL_HREFS = [
  "/developers/docs/manual/",
  "/developers/docs/manual/developer/",
  "/developers/docs/manual/organizer/",
  "/developers/docs/manual/participant/",
  "/developers/docs/manual/problem-author/",
] as const;
const ORGANIZER_MANUAL_SOURCE = readFileSync(
  "src/app/developers/docs/manual/organizer/page.mdx",
  "utf8",
);
const ORGANIZER_MANUAL_JA_SOURCE = readFileSync(
  "src/app/developers/docs/manual/organizer/page.ja.mdx",
  "utf8",
);
const PARTICIPANT_MANUAL_SOURCE = readFileSync(
  "src/app/developers/docs/manual/participant/page.mdx",
  "utf8",
);
const PARTICIPANT_MANUAL_JA_SOURCE = readFileSync(
  "src/app/developers/docs/manual/participant/page.ja.mdx",
  "utf8",
);

describe("docs registry — role manuals (#2818)", () => {
  it("should expose exactly the role chooser and four manuals in their own section", () => {
    const section = DOC_SECTIONS.find((candidate) => candidate.title === "Role manuals");
    expect(section?.pages.map((page) => page.href)).toEqual(ROLE_MANUAL_HREFS);
  });

  it("should expose every role manual as a known internal route", () => {
    const routes = allRoutes();
    for (const href of ROLE_MANUAL_HREFS) expect(routes).toContain(href);
  });

  it("should find organizer database and parameter guidance in both languages", () => {
    const english = searchIndex("organizer database parameters DynamoDB Turso");
    expect(english.some((result) => result.href === "/developers/docs/manual/organizer/")).toBe(
      true,
    );

    const japanese = searchIndex("競技開催者 データベース パラメータ");
    expect(japanese.some((result) => result.href === "/developers/docs/manual/organizer/")).toBe(
      true,
    );
  });

  it("should document the actual backend switch and its safety boundary in both languages", () => {
    for (const source of [ORGANIZER_MANUAL_SOURCE, ORGANIZER_MANUAL_JA_SOURCE]) {
      expect(source).toContain("CDK_PARAM_CONTROL_DATA_BACKEND");
      expect(source).toContain("CDK_PARAM_TURSO_DATABASE_URL");
      expect(source).toContain("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME");
      expect(source).toContain("make turso-live ENV=development");
      expect(source).toContain("RETAIN");
    }
    expect(ORGANIZER_MANUAL_SOURCE).toContain("not yet been live-verified");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("ライブ検証は未実施");
  });

  it("should keep WordPress out of participant onboarding", () => {
    expect(PARTICIPANT_MANUAL_SOURCE).not.toMatch(/wordpress/i);
    expect(PARTICIPANT_MANUAL_JA_SOURCE).not.toMatch(/wordpress/i);
  });

  it("should explain Docker in plain language for participants", () => {
    expect(PARTICIPANT_MANUAL_SOURCE).toContain(
      "A way to package an application and its dependencies so a matching practice environment can be recreated",
    );
    expect(PARTICIPANT_MANUAL_JA_SOURCE).toContain(
      "アプリと必要なソフトをまとめ、同じ練習環境を再現しやすくする仕組み",
    );
  });
});

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

  it("should branch organizers from first-pack to the use-existing-pack path near the top", () => {
    const branchLink =
      "Just want to run an existing pack? → [Use an existing pack](/developers/docs/operate/use-existing-pack/).";

    expect(FIRST_PACK_SOURCE).toContain(branchLink);
    const prerequisitesHeading = "## Prerequisites";
    expect(FIRST_PACK_SOURCE).toContain(prerequisitesHeading);
    expect(FIRST_PACK_SOURCE.indexOf(branchLink)).toBeLessThan(
      FIRST_PACK_SOURCE.indexOf(prerequisitesHeading),
    );
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
    USE_EXISTING_PACK_HREF,
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

  it("should register the use-existing-pack organizer page as preview documentation", () => {
    const page = findDocBySlug(USE_EXISTING_PACK_SLUG);
    expect(page).toBeDefined();
    expect(page?.href).toBe(USE_EXISTING_PACK_HREF);
    expect(page?.maturity).toBe("preview");
  });

  it("should find the use-existing-pack page by pack install and provenance terms", () => {
    const installResults = searchIndex("pack install git 40-hex");
    expect(installResults.some((r) => r.href === USE_EXISTING_PACK_HREF)).toBe(true);

    const provenanceResults = searchIndex("pack provenance");
    expect(provenanceResults.some((r) => r.href === USE_EXISTING_PACK_HREF)).toBe(true);
  });

  it("should keep the event-creation step preview until live verification is complete", () => {
    expect(USE_EXISTING_PACK_SOURCE).toContain(
      '## 4. Create the event <MaturityBadge level="preview" />',
    );
    expect(USE_EXISTING_PACK_SOURCE).toContain("pending live batch verification");
  });

  it("should find the architecture page by a Japanese search term", () => {
    const results = searchIndex("アーキテクチャ プレーン");
    expect(results.some((r) => r.href === ARCHITECTURE_HREF)).toBe(true);
  });
});
