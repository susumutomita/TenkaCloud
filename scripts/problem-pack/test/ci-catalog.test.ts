import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CatalogLockSchema, lockPath, selectedCatalogSnapshots } from "../catalog-read";
import { prepareCiCatalog } from "./prepare-ci-catalog";

test("offline preparation selects local contract inputs without reading or replacing product source pins", () => {
  const root = mkdtempSync(join(tmpdir(), "tenka-offline-catalog-"));
  const sources = '{"operator":"source selection must remain unchanged"}\n';
  try {
    writeFileSync(join(root, "catalog-sources.json"), sources);
    prepareCiCatalog(root);
    const selected = CatalogLockSchema.parse(JSON.parse(readFileSync(lockPath(root), "utf8")));
    expect(selected.sources).toHaveLength(1);
    expect(selected.sources.every((source) => "path" in source)).toBe(true);
    expect(
      selected.retained?.some((source) => "path" in source && source.path.endsWith("/retained")),
    ).toBe(true);
    expect(selectedCatalogSnapshots(root)[0]?.problemRoot).toContain("catalog-store/snapshots");
    expect(
      existsSync(join(root, "problems/battles/crypto-battle/coordination/crypto-battle.ts")),
    ).toBe(true);
    expect(readFileSync(join(root, "catalog-sources.json"), "utf8")).toBe(sources);
    expect(existsSync(join(root, "catalog-lock.json"))).toBe(false);
    const first = readFileSync(lockPath(root), "utf8");
    prepareCiCatalog(root);
    expect(readFileSync(lockPath(root), "utf8")).toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture preparation refuses to replace an operator's existing catalog selection", () => {
  const root = mkdtempSync(join(tmpdir(), "tenka-protect-selection-"));
  const selection = JSON.stringify({
    schemaVersion: 1,
    sources: [
      {
        url: "https://example.invalid/operator.git",
        ref: "main",
        commit: "a".repeat(40),
        digest: "b".repeat(64),
        problemsRoot: ".",
      },
    ],
  });
  try {
    mkdirSync(dirname(lockPath(root)), { recursive: true });
    writeFileSync(lockPath(root), selection);
    expect(() => prepareCiCatalog(root)).toThrow(
      "Refusing to replace a non-fixture catalog selection",
    );
    expect(readFileSync(lockPath(root), "utf8")).toBe(selection);
    expect(existsSync(join(root, "problems"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency installation has no catalog work and CI consumers prepare offline inputs explicitly", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const install = readFileSync(join(root, ".github/actions/bun-install/action.yml"), "utf8");
  expect(install).toContain("make install_ci");
  expect(install).not.toContain("catalog");
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: { run?: string }[]; needs?: string[] }>;
  };
  for (const name of ["gates", "lint-ts", "typecheck", "build", "coverage"])
    expect(
      workflow.jobs[name]?.steps?.some(
        (step) => step.run === "bun run scripts/problem-pack/test/prepare-ci-catalog.ts",
      ),
    ).toBe(true);
  const commands = Object.values(workflow.jobs)
    .flatMap((job) => job.steps?.flatMap((step) => step.run ?? []) ?? [])
    .join("\n");
  expect(commands).not.toContain("catalog download");
  expect(commands).not.toContain("validate-problems");
  expect(workflow.jobs.ci?.needs).toEqual([
    "gates",
    "lint-ts",
    "typecheck",
    "build",
    "coverage",
    "source-bundle-macos",
    "actions-lock",
  ]);
});
