import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCatalogSelection, selectedCatalogSnapshots } from "../../problem-pack/catalog-read";
import { runLocalHost } from "../application";
import { assertHostCatalogBuild } from "../build";
import { runManagedLocal } from "../local";

for (const args of [[], ["--no-build"]])
  test(`first startup ${args.join(" ")} explains explicit acquisition before opening listeners or inventing a selection`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-unselected-startup-"));
    const config = join(root, "catalog-sources.json");
    const content = JSON.stringify({
      schemaVersion: 1,
      sources: [{ url: "https://example.invalid/review-first.git", ref: "a".repeat(40) }],
    });
    writeFileSync(config, content);
    try {
      await expect(runLocalHost(args, { repositoryRoot: root })).rejects.toThrow(
        "make catalog-download CATALOG_SOURCES=my-catalogs.json",
      );
      expect(readFileSync(config, "utf8")).toBe(content);
      expect(existsSync(join(root, ".tenkacloud/catalog-store/selected.json"))).toBe(false);
      expect(existsSync(join(root, ".tenkacloud/catalog-store/mutation.lock"))).toBe(false);
      expect(existsSync(join(root, ".tenkacloud/host/hosting.sqlite"))).toBe(false);
      expect(existsSync(join(root, "problems"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const args of [[], ["--no-build"]])
  test(`make local launcher ${args.join(" ")} refuses an unselected root before creating its controller state`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-unselected-launcher-"));
    try {
      await expect(runManagedLocal(root, args)).rejects.toThrow("make catalog-download");
      expect(existsSync(join(root, ".tenkacloud"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a corrupt catalog selection remains a validation failure rather than an empty or default catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-corrupt-selection-"));
  try {
    mkdirSync(join(root, ".tenkacloud/catalog-store"), { recursive: true });
    writeFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "{}");
    expect(readCatalogSelection(root)).toBe("{}");
    expect(() => selectedCatalogSnapshots(root)).toThrow();
    expect(readFileSync(join(root, ".tenkacloud/catalog-store/selected.json"), "utf8")).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-build explains a missing build and still refuses selection drift", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-catalog-build-"));
  try {
    mkdirSync(join(root, ".tenkacloud/catalog-store"), { recursive: true });
    const selection = join(root, ".tenkacloud/catalog-store/selected.json");
    writeFileSync(selection, "selected edition A");
    expect(() => assertHostCatalogBuild(root)).toThrow("without --no-build");
    mkdirSync(join(root, ".tenkacloud/host-build"), { recursive: true });
    const manifest = join(root, ".tenkacloud/host-build/catalog-selection.json");
    writeFileSync(manifest, "selected edition B");
    expect(() => assertHostCatalogBuild(root)).toThrow("rebuild before starting");
    writeFileSync(manifest, readFileSync(selection));
    expect(() => assertHostCatalogBuild(root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
