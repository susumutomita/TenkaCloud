import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  test(`make local launcher ${args.join(" ")} rejects missing configuration before creating its controller state`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-unselected-launcher-"));
    try {
      await expect(runManagedLocal(root, args)).rejects.toThrow(
        "Catalog acquisition from catalog-sources.json failed",
      );
      expect(existsSync(join(root, ".tenkacloud"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const args of [[], ["--no-build"]])
  test(`make local ${args.join(" ")} stops a failed branch fetch before controller or event state`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-branch-startup-"));
    writeFileSync(
      join(root, "catalog-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/catalog.git", ref: "main" }],
      }),
    );
    try {
      await expect(
        runManagedLocal(root, args, {
          resolveRef: () => {
            throw new Error("main branch unavailable");
          },
        }),
      ).rejects.toThrow("main branch unavailable");
      expect(existsSync(join(root, ".tenkacloud/host"))).toBe(false);
      expect(existsSync(join(root, ".tenkacloud/catalog-store/selected.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("make local acquires the configured branch before checking built interfaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "tc-acquired-startup-"));
  writeFileSync(
    join(root, "catalog-sources.json"),
    JSON.stringify({
      schemaVersion: 1,
      sources: [{ url: "https://example.invalid/catalog.git", ref: "main" }],
    }),
  );
  try {
    await expect(
      runManagedLocal(root, ["--no-build"], {
        resolveRef: (_url, ref) => {
          expect(ref).toBe("main");
          return "a".repeat(40);
        },
        fetcher: (request) => {
          mkdirSync(join(request.destinationDir, "challenges"));
          cpSync(
            join(import.meta.dirname, "../../../problems/challenges/sqli-demo"),
            join(request.destinationDir, "challenges/sqli-demo"),
            { recursive: true },
          );
        },
      }),
    ).resolves.toBe(1);
    expect(selectedCatalogSnapshots(root)[0]?.revision.commit).toBe("a".repeat(40));
    expect(existsSync(join(root, ".tenkacloud/host/hosting.sqlite"))).toBe(false);
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
