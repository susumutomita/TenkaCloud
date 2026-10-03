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

  it("should find current organizer storage guidance in both languages", () => {
    for (const query of [
      "organizer database parameters SQLite Turso",
      "競技開催者 データベース パラメータ",
    ]) {
      expect(
        searchIndex(query).some((result) => result.href === "/developers/docs/manual/organizer/"),
      ).toBe(true);
    }
  });

  it("should describe current cloud support without retired setup commands", () => {
    expect(ORGANIZER_MANUAL_SOURCE).toContain("has not been established");
    expect(ORGANIZER_MANUAL_SOURCE).toContain("environment names are not an IAM security boundary");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("環境名は IAM の分離境界になりません");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("実 AWS への配置は未検証");
    for (const source of [ORGANIZER_MANUAL_SOURCE, ORGANIZER_MANUAL_JA_SOURCE]) {
      for (const service of ["Lambda", "Turso", "DynamoDB"]) expect(source).toContain(service);
    }
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
      expect(source).toContain("make down");
      expect(source).not.toContain("make local-down");
      expect(source).not.toContain("make host");
      expect(source).not.toContain("bun run tenkacloud local");
    }
  });

  it("should document the unified local flow and scoped cloud commands", () => {
    for (const source of [ORGANIZER_MANUAL_SOURCE, ORGANIZER_MANUAL_JA_SOURCE]) {
      for (const command of ["make local", "make down", "make deploy", "make destroy"]) {
        expect(source).toContain(command);
      }
      expect(source).not.toContain("lite-pipeline.yaml");
      expect(source).not.toContain("make deploy-saas");
      expect(source).toContain("106");
      for (const detail of [
        "512",
        "40",
        "100",
        "105",
        "4096",
        "Start / resume",
        "Stop (keep data)",
        "RAM",
        "--max-active-per-team",
        "--max-active-environments",
        "--container-memory-mib",
      ]) {
        expect(source).toContain(detail);
      }
      expect(source).not.toContain("40 total jobs");
      expect(source).not.toContain("100 jobs のため拒否");
    }
    expect(ORGANIZER_MANUAL_SOURCE).toContain("reviewed IAM setup");
    expect(ORGANIZER_MANUAL_SOURCE).toContain("deletes platform-owned data by default");
    expect(ORGANIZER_MANUAL_SOURCE).toContain("leaves external Turso rows");
    expect(ORGANIZER_MANUAL_SOURCE).toContain("make destroy-all");
    expect(ORGANIZER_MANUAL_SOURCE).toContain("--drain-events");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("権限設定");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("データを保持");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("基盤とデフォルトの所有データを削除");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("外部 Turso の行は残し");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("make destroy-all");
    expect(ORGANIZER_MANUAL_JA_SOURCE).toContain("--drain-events");
  });

  it("should distinguish participant resume, disk retention and representative real terminal evidence", () => {
    for (const source of [PARTICIPANT_MANUAL_SOURCE, PARTICIPANT_MANUAL_JA_SOURCE]) {
      for (const detail of ["Start / resume", "Stop (keep data)", "RAM", "PostgreSQL", "15"]) {
        expect(source).toContain(detail);
      }
    }
    expect(PARTICIPANT_MANUAL_SOURCE).toContain("does not automatically evict or reset");
    expect(PARTICIPANT_MANUAL_SOURCE).toContain("real Docker/browser rehearsal");
    expect(PARTICIPANT_MANUAL_SOURCE).toContain("does not verify every one");
    expect(PARTICIPANT_MANUAL_JA_SOURCE).toContain("実 Docker とブラウザ");
    expect(PARTICIPANT_MANUAL_JA_SOURCE).toContain("全問題を通して確認したわけではありません");
    expect(PARTICIPANT_MANUAL_SOURCE).toContain("remain stopped until you resume");
    expect(PARTICIPANT_MANUAL_JA_SOURCE).toContain("自動退避や初期化は行いません");
    expect(PARTICIPANT_MANUAL_JA_SOURCE).toContain("再開するまで停止したまま");
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

describe("docs registry — current references", () => {
  it("should remove retired Lite routes from navigation and search", () => {
    for (const slug of ["reference/lite-settings", "reference/lite-messages"]) {
      expect(findDocBySlug(slug)).toBeUndefined();
      expect(allRoutes()).not.toContain(`/developers/docs/${slug}/`);
    }
    expect(DOC_SECTIONS.some((section) => section.title === "Legacy reference")).toBe(false);
  });

  it("should keep current setup and recovery guidance searchable", () => {
    expect(
      searchIndex("local-reset organizer key").some(
        (result) => result.href === "/developers/docs/getting-started/",
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

  it("should find the deploy-paths page by current deployment status", () => {
    const results = searchIndex("standard CDKToolkit");
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

  it("should distinguish missing pack event integration from missing live evidence", () => {
    expect(USE_EXISTING_PACK_SOURCE).toContain("Event integration is unavailable");
    expect(USE_EXISTING_PACK_SOURCE).toContain("implementation gap");
    expect(USE_EXISTING_PACK_SOURCE).toContain("Installed packs do not appear");
    expect(USE_EXISTING_PACK_SOURCE).not.toContain("make pack-activate ARGS=");
    expect(FIRST_PACK_SOURCE).toContain("does not add");
    expect(FIRST_PACK_SOURCE).not.toContain("--tenant acme");
  });

  it("should keep architecture search headings aligned with the actual page", () => {
    const source = readFileSync("src/app/developers/docs/concepts/architecture/page.mdx", "utf8");
    const headings = [...source.matchAll(/^<h2 id="([^"]+)">(.+)<\/h2>$/gm)].map((match) => ({
      id: match[1],
      text: match[2],
    }));
    const page = findDocBySlug("concepts/architecture");
    expect(page?.headings).toEqual(headings);
    expect(source).not.toMatch(/^## /m);
    for (const [term, anchor] of [
      ["AWS exercises and cloud platform", "cloud-components"],
      ["Local competition and Docker", "local-play-and-docker"],
    ]) {
      expect(
        searchIndex(term).some((result) => result.href === `${ARCHITECTURE_HREF}#${anchor}`),
      ).toBe(true);
    }
  });

  it("should find the architecture page by a Japanese search term", () => {
    const results = searchIndex("アーキテクチャ プレーン");
    expect(results.some((r) => r.href === ARCHITECTURE_HREF)).toBe(true);
  });
});

describe("integration candidate documentation contract", () => {
  it("should keep both quickstarts explicit about safe shutdown and local-only Docker scope", () => {
    for (const filename of ["page.mdx", "page.ja.mdx"]) {
      const source = readFileSync(`src/app/developers/docs/getting-started/${filename}`, "utf8");
      for (const command of ["make local", "make down", "make deploy", "make destroy"])
        expect(source).toContain(command);
      expect(source).not.toContain("make host");
      expect(source).not.toContain("make local-down");
      expect(source).toMatch(/preserv|保持/);
      expect(source).toMatch(
        /Docker\/Compose exercises are local-only|Docker \/ Compose 問題はローカル開催専用/,
      );
      expect(source).toMatch(/not listed in the cloud catalog|クラウドのカタログには表示しません/);
      expect(source).toContain("Cryptography Battle");
      expect(source).toMatch(
        /Live AWS and hosted Turso event capacity remain unverified|実 AWS・hosted Turso での大会性能は未検証/,
      );
      expect(source).toMatch(/reviewed IAM|権限設定/);
      expect(source).toMatch(/generic CloudFormation|汎用 CloudFormation/);
      expect(source).toContain("106");
      expect(source).toMatch(/in progress|進行中/);
    }
  });

  it("should stop advertising executable legacy hosting in current search metadata", () => {
    for (const slug of [
      "getting-started",
      "manual/organizer",
      "operate/deploy-paths",
      "operate/run-an-event",
    ]) {
      const page = findDocBySlug(slug);
      expect(page?.maturity).toBe("preview");
      expect(page?.body).not.toContain("currently recommended Lite deployment");
      expect(page?.body).not.toContain("executable Lite procedure");
      expect(page?.body).not.toContain("CDK_PARAM_CONTROL_DATA_BACKEND");
      expect(page?.body).toContain("make local");
      expect(page?.body).toContain("make down");
    }
  });
});
