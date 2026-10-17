import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  bumpCatalog,
  challengeUrl,
  findCatalogBump,
  isNewerRelease,
  planCatalogBump,
} from "../catalog-bump.js";
import { lockPath, store } from "../catalog-read.js";

const previous = {
  url: challengeUrl,
  ref: "v1.11.0",
  commit: "a".repeat(40),
  digest: "b".repeat(64),
  problemsRoot: ".",
};
const retained = { ...previous, ref: previous.commit };
const other = { url: "https://example.invalid/other.git", ref: "main", subdir: "packs" };
const otherRevision = { ...previous, ...other, commit: "c".repeat(40) };
const selection = { schemaVersion: 1, sources: [{ url: challengeUrl, ref: "v1.11.0" }, other] };
const lock = { schemaVersion: 1, sources: [previous, otherRevision] };
const next = { ...previous, ref: "v1.12.0", commit: "d".repeat(40), digest: "e".repeat(64) };
const release = {
  tag_name: "v1.12.0",
  html_url: "https://github.com/susumutomita/TenkaCloudChallenge/releases/tag/v1.12.0",
  draft: false,
  prerelease: false,
};
function fixture(run: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "catalog-bump-test-"));
  writeFileSync(join(root, "catalog-sources.json"), JSON.stringify(selection));
  writeFileSync(join(root, "catalog-lock.json"), JSON.stringify(lock));
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}
function plan() {
  const result = planCatalogBump(selection, lock, "v1.12.0");
  if (!result) throw new Error("Expected bump");
  return result;
}
function acquired(root: string, revisions = [next, otherRevision]) {
  mkdirSync(store(root), { recursive: true });
  writeFileSync(
    lockPath(root),
    JSON.stringify({ schemaVersion: 1, sources: revisions, retained: [retained, next] }),
  );
}

test("newer-tag decision uses semver ordering and rejects prereleases and non-semver refs", () => {
  for (const [current, target, expected] of [
    ["v1.9.0", "v1.10.0", true],
    ["v1.11.0", "v2.0.0", true],
    ["1.11.0", "v1.12.0", true],
    ["v1.12.0-rc.1", "v1.12.0", true],
    ["v1.11.0", "v1.11.0", false],
    ["v1.11.0", "v1.10.9", false],
    ["v1.11.0", "v1.12.0-rc.1", false],
    ["v1.11.0+old", "v1.11.0+new", false],
    ["main", "v2.0.0", false],
    [previous.commit, "v2.0.0", false],
    ["v01.11.0", "v2.0.0", false],
    ["v1.11.0", "v1.12", false],
    ["v1.11.0", "v1.12.0;touch bad", false],
  ] satisfies [string, string, boolean][])
    expect(isNewerRelease(current, target)).toBe(expected);
});

test("bump transforms both files, appends immutable retained pins and preserves other fields", () =>
  fixture((root) => {
    const result = bumpCatalog(root, plan(), {
      acquire: (path) => {
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
          schemaVersion: 1,
          sources: [{ url: challengeUrl, ref: "v1.12.0" }, other],
          retained: [retained],
        });
        expect(readFileSync(join(root, "catalog-sources.json"), "utf8")).toBe(
          JSON.stringify(selection),
        );
        acquired(root);
      },
      prepare: () => {
        expect(readFileSync(join(root, "catalog-lock.json"), "utf8")).toBe(JSON.stringify(lock));
      },
    });
    expect(result).toEqual({
      schemaVersion: 1,
      sources: [next, otherRevision],
      retained: [retained],
    });
    expect(JSON.parse(readFileSync(join(root, "catalog-sources.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      sources: [{ url: challengeUrl, ref: "v1.12.0" }, other],
      retained: [retained],
    });
    expect(JSON.parse(readFileSync(join(root, "catalog-lock.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      sources: [next, otherRevision],
      retained: [retained],
    });
  }));

test("retained entries dedupe by commit independently in both files", () => {
  const older = { ...retained, commit: "f".repeat(40), ref: "f".repeat(40), subdir: "old" };
  const result = planCatalogBump(
    { ...selection, retained: [older, retained, retained] },
    { ...lock, retained: [retained, retained] },
    "v1.12.0",
  );
  expect(result?.selection.retained).toEqual([older, retained]);
  expect(result?.retained).toEqual([retained]);
  expect(planCatalogBump(selection, lock, "v1.11.0")).toBeNull();
  expect(() =>
    planCatalogBump(selection, { ...lock, sources: [{ ...previous, ref: "wrong" }] }, "v1.12.0"),
  ).toThrow("disagree");
});

for (const phase of ["acquisition", "verification", "preparation"])
  test(`${phase} failure refuses to write either reviewed file`, () =>
    fixture((root) => {
      expect(() =>
        bumpCatalog(root, plan(), {
          acquire: () => {
            if (phase === "acquisition") throw new Error("offline");
            acquired(
              root,
              phase === "verification"
                ? [{ ...next, digest: "bad" }, otherRevision]
                : [next, otherRevision],
            );
          },
          prepare: () => {
            if (phase === "preparation") throw new Error("invalid catalog");
          },
        }),
      ).toThrow();
      expect(readFileSync(join(root, "catalog-sources.json"), "utf8")).toBe(
        JSON.stringify(selection),
      );
      expect(readFileSync(join(root, "catalog-lock.json"), "utf8")).toBe(JSON.stringify(lock));
    }));

test("a selected ref mismatch or missing retained revision fails verification before writing", () =>
  fixture((root) => {
    for (const mismatch of [true, false]) {
      expect(() =>
        bumpCatalog(root, plan(), {
          acquire: () => {
            acquired(root, mismatch ? [previous, otherRevision] : [next, otherRevision]);
            if (!mismatch)
              writeFileSync(
                lockPath(root),
                JSON.stringify({ schemaVersion: 1, sources: [next, otherRevision] }),
              );
          },
          prepare: () => {
            throw new Error("must not prepare");
          },
        }),
      ).toThrow(mismatch ? "unexpected sources" : "differs from catalog-lock.json");
      expect(readFileSync(join(root, "catalog-sources.json"), "utf8")).toBe(
        JSON.stringify(selection),
      );
      expect(readFileSync(join(root, "catalog-lock.json"), "utf8")).toBe(JSON.stringify(lock));
    }
  }));

test("release lookup is injected, supports overrides and skips drafts, prereleases and existing branches/PRs", () =>
  fixture(async (root) => {
    const requested: string[] = [];
    const deps = {
      release: async (tag: string) => {
        requested.push(tag);
        return release;
      },
      exists: async (branch: string) => {
        expect(branch).toBe("catalog/bump-v1.12.0");
        return false;
      },
    };
    expect((await findCatalogBump(root, "", deps))?.branch).toBe("catalog/bump-v1.12.0");
    expect((await findCatalogBump(root, "v1.12.0", deps))?.plan.oldTag).toBe("v1.11.0");
    expect(requested).toEqual(["", "v1.12.0"]);
    expect(await findCatalogBump(root, "", { ...deps, exists: async () => true })).toBeNull();
    for (const patch of [
      { draft: true },
      { prerelease: true },
      { tag_name: "v1.10.0" },
      { tag_name: "v2.0.0-rc.1" },
    ])
      expect(
        await findCatalogBump(root, "", {
          ...deps,
          release: async () => ({ ...release, ...patch }),
        }),
      ).toBeNull();
    expect(await findCatalogBump(root, "v1.13.0", deps)).toBeNull();
  }));

test("non-semver current refs and non-newer overrides skip release lookup", () =>
  fixture(async (root) => {
    const deps = {
      release: async () => {
        throw new Error("must not lookup");
      },
      exists: async () => {
        throw new Error("must not query origin");
      },
    };
    expect(await findCatalogBump(root, "v1.10.0", deps)).toBeNull();
    writeFileSync(
      join(root, "catalog-sources.json"),
      JSON.stringify({ schemaVersion: 1, sources: [{ url: challengeUrl, ref: "main" }] }),
    );
    expect(await findCatalogBump(root, "", deps)).toBeNull();
  }));

test("CI keeps the required ci gate", () => {
  const root = join(import.meta.dirname, "../../..");
  const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  expect(ci.on).toHaveProperty("workflow_dispatch");
  expect(ci.jobs.ci.needs).toEqual([
    "gates",
    "lint-ts",
    "typecheck",
    "build",
    "coverage",
    "source-bundle-macos",
  ]);
  expect(ci.jobs.ci.if).toBe("always()");
  const jobs = z
    .record(z.string(), z.object({ if: z.string().optional(), name: z.string().optional() }))
    .parse(ci.jobs);
  for (const job of Object.values(jobs)) {
    expect(job.if === undefined || job.if === "always()").toBe(true);
    expect(job.name).toBeUndefined();
  }
});
