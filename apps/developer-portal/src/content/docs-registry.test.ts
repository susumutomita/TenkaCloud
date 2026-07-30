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
const PROBLEM_AUTHOR_MANUAL_SOURCE = readFileSync(
  "src/app/developers/docs/manual/problem-author/page.mdx",
  "utf8",
);
const PROBLEM_AUTHOR_MANUAL_JA_SOURCE = readFileSync(
  "src/app/developers/docs/manual/problem-author/page.ja.mdx",
  "utf8",
);
const LITE_SETTINGS_SOURCE = readFileSync(
  "src/app/developers/docs/reference/lite-settings/page.mdx",
  "utf8",
);
const LITE_SETTINGS_JA_SOURCE = readFileSync(
  "src/app/developers/docs/reference/lite-settings/page.ja.mdx",
  "utf8",
);
const LITE_MESSAGES_SOURCE = readFileSync(
  "src/app/developers/docs/reference/lite-messages/page.mdx",
  "utf8",
);
const LITE_MESSAGES_JA_SOURCE = readFileSync(
  "src/app/developers/docs/reference/lite-messages/page.ja.mdx",
  "utf8",
);

describe("docs registry — role manuals (#2818)", () => {
  it("should expose exactly the role chooser and four manuals in their own section", () => {
    const section = DOC_SECTIONS.find((candidate) => candidate.title === "Role manuals");
    expect(section?.pages.map((page) => page.href)).toEqual(ROLE_MANUAL_HREFS);
    expect(DOC_SECTIONS[0]?.title).toBe("Role manuals");
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
    for (const source of [LITE_SETTINGS_SOURCE, LITE_SETTINGS_JA_SOURCE]) {
      expect(source).toContain("CDK_PARAM_CONTROL_DATA_BACKEND");
      expect(source).toContain("CDK_PARAM_TURSO_DATABASE_URL");
      expect(source).toContain("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME");
      expect(source).toMatch(/do not synchronize|同期されません/);
    }
    expect(ORGANIZER_MANUAL_SOURCE).toContain("has not been");
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

  it("should use the public Make targets in the participant manual", () => {
    for (const source of [PARTICIPANT_MANUAL_SOURCE, PARTICIPANT_MANUAL_JA_SOURCE]) {
      expect(source).toContain("make local");
      expect(source).toContain("make local-down");
      expect(source).not.toContain("bun run tenkacloud local");
    }
  });

  it("should separate the executable Lite path from unverified SaaS guidance", () => {
    for (const source of [ORGANIZER_MANUAL_SOURCE, ORGANIZER_MANUAL_JA_SOURCE]) {
      expect(source).toContain("lite-pipeline.yaml");
      expect(source).toContain("CodeBuild");
      expect(source).toContain("CodePipeline");
      expect(source).toMatch(/no recent|最近の/);
      expect(source).toContain("/developers/docs/reference/lite-settings/");
      expect(source).toContain("/developers/docs/reference/lite-messages/");
    }
  });

  it("should show the problem-author publication decision flow in both languages", () => {
    expect(PROBLEM_AUTHOR_MANUAL_SOURCE).toContain("/docs/assets/problem-author-flow.en.svg");
    expect(PROBLEM_AUTHOR_MANUAL_JA_SOURCE).toContain("/docs/assets/problem-author-flow.ja.svg");
    for (const source of [PROBLEM_AUTHOR_MANUAL_SOURCE, PROBLEM_AUTHOR_MANUAL_JA_SOURCE]) {
      expect(source).toContain("Not run");
      expect(source).toContain("make pack-validate");
    }
  });
});

describe("docs registry — Lite technical references", () => {
  const referenceHrefs = [
    "/developers/docs/reference/lite-settings/",
    "/developers/docs/reference/lite-messages/",
  ];

  it("should register the setting contract and message catalog", () => {
    for (const href of referenceHrefs) expect(allRoutes()).toContain(href);
    expect(findDocBySlug("reference/lite-settings")).toBeDefined();
    expect(findDocBySlug("reference/lite-messages")).toBeDefined();
  });

  it("should define ExternalId format and the exact wizard message", () => {
    for (const source of [LITE_SETTINGS_SOURCE, LITE_SETTINGS_JA_SOURCE]) {
      expect(source).toContain("16");
      expect(source).toContain("128");
      expect(source).toContain("_ = , . @ : / -");
    }
    for (const source of [LITE_MESSAGES_SOURCE, LITE_MESSAGES_JA_SOURCE]) {
      expect(source).toContain("16〜128文字で、半角英数字と _ = , . @ : / - を使ってください");
      expect(source).toMatch(/System action|システムの処置/);
      expect(source).toMatch(/Operator action|利用者の処置/);
    }
  });

  it("should make settings and errors findable in Japanese and English", () => {
    expect(
      searchIndex("ExternalId 16 128").some(
        (result) => result.href === "/developers/docs/reference/lite-settings/",
      ),
    ).toBe(true);
    expect(
      searchIndex("設定 メッセージ 要因 処置").some(
        (result) => result.href === "/developers/docs/reference/lite-messages/",
      ),
    ).toBe(true);
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
