import { globSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { metadataToEntry, type ProblemMetadata } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import { problemCatalogPlugin, projectProblemCatalog } from "../../build/problem-catalog";

const root = resolve(process.cwd(), "../..");

describe("problem catalog build projection", () => {
  it("runs the catalog transform before Vite turns JSON into JavaScript", () => {
    const plugin = problemCatalogPlugin();
    expect(plugin.enforce).toBe("pre");
    expect(plugin.transform).toBe(projectProblemCatalog);
  });
  it("keeps every existing participant field while moving only JA/EN instructions to lazy modules", () => {
    const paths = globSync("problems/*/*/metadata.json", { cwd: root });
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const id = resolve(root, path);
      const code = readFileSync(id, "utf8");
      const expected = metadataToEntry(JSON.parse(code) as ProblemMetadata);
      const catalog = JSON.parse(projectProblemCatalog(code, `${id}?portal-catalog`)!);
      const instructions = JSON.parse(projectProblemCatalog(code, `${id}?portal-instructions`)!);
      expect(catalog.instructions).toBeUndefined();
      expect(catalog.i18n?.en?.instructions).toBeUndefined();
      const restored = {
        ...catalog,
        instructions: instructions.instructions,
        ...(expected.i18n
          ? { i18n: { en: { ...catalog.i18n.en, instructions: instructions.englishInstructions } } }
          : {}),
      };
      expect(JSON.parse(JSON.stringify(restored))).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(catalog).not.toHaveProperty("description");
      expect(catalog).not.toHaveProperty("writeup");
    }
  });

  it("keeps host pre-start instructions out of both eager and lazy projections", () => {
    const id = "/repo/problems/challenges/hello-world/metadata.json";
    const source = JSON.stringify({
      id: "hello-world",
      name: "Hello",
      instructions: "UNRELEASED_JA",
      description: "AUTHOR_ONLY",
      i18n: { en: { instructions: "UNRELEASED_EN" } },
    });
    for (const query of ["portal-catalog", "portal-instructions"]) {
      const moduleId = `${id}?${query}`;
      const safe = execFileSync(
        "bun",
        ["-e", 'import { publicMetadata } from "./scripts/local-host/browser-metadata.ts"; process.stdout.write(publicMetadata(process.argv[1], process.argv[2]));', source, moduleId],
        { cwd: root, encoding: "utf8" },
      );
      const output = projectProblemCatalog(safe, moduleId)!;
      expect(output).not.toContain("UNRELEASED");
      expect(output).not.toContain("AUTHOR_ONLY");
    }
  });

  it("leaves unrelated JSON and ordinary metadata imports alone", () => {
    expect(projectProblemCatalog("{}", "/src/config.json?portal-catalog")).toBeNull();
    expect(projectProblemCatalog("{}", "/problems/challenges/a/metadata.json")).toBeNull();
  });
});
