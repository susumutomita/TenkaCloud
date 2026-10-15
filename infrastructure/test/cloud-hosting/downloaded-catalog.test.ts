import * as fs from "node:fs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { downloadCatalog } from "../../../scripts/problem-pack/downloaded-catalog.js";
import { downloadedCloudCatalog } from "../../lib/cloud-hosting/downloaded-catalog.js";
import { buildCloudExecutionArtifacts } from "../../lib/cloud-hosting/execution-artifacts.js";
import { DeployCreateRequestedDetailSchema } from "../../lib/problem-deploy/handlers/shared/events.js";

const repository = resolve(import.meta.dirname, "../../..");
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, cpSync: vi.fn(actual.cpSync) };
});
test("Cloud selects only requested sources and retains immutable source roots and old commit prefixes", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-download-"));
  const config = (commit: string) => ({
    schemaVersion: 1,
    sources: [{ url: "https://example.invalid/aws.git", ref: commit }],
  });
  const fetcher = (request: { destinationDir: string }) => {
    cpSync(
      join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
      request.destinationDir,
      { recursive: true },
    );
    mkdirSync(join(request.destinationDir, "shared"));
    writeFileSync(join(request.destinationDir, "shared/input.txt"), "retained root shared input");
    writeFileSync(join(request.destinationDir, "problems/challenges/README.txt"), "category notes");
  };
  try {
    downloadCatalog(root, config("1".repeat(40)), { fetcher });
    const first = downloadedCloudCatalog(root);
    const paths = Object.values(first.bundle.catalog as Record<string, string>);
    expect(paths).toHaveLength(1);
    expect(DeployCreateRequestedDetailSchema.shape.problemDir.safeParse(paths[0]).success).toBe(
      true,
    );
    expect(paths[0]).toContain(`/${"1".repeat(40)}/`);
    expect(
      readFileSync(join(String(first.packAssets[0]?.problemsRootAbs), "shared/input.txt"), "utf8"),
    ).toBe("retained root shared input");
    downloadCatalog(root, config("2".repeat(40)), { fetcher });
    const next = downloadedCloudCatalog(root);
    expect(next.packAssets.map((asset) => asset.version).sort()).toEqual([
      "1".repeat(40),
      "2".repeat(40),
    ]);
    expect(Object.values(next.bundle.catalog as Record<string, string>)).toHaveLength(1);
    const artifact = buildCloudExecutionArtifacts({
      repositoryRoot: root,
      bundle: next.bundle,
      packAssets: next.packAssets,
      sourceArchive: { bucket: "source", key: "source.zip", versionId: "fixed" },
    });
    const publicCatalog = artifact.catalog.publicMetadata;
    expect(Object.keys(publicCatalog ?? {})).toHaveLength(1);
    expect(JSON.stringify(publicCatalog)).not.toContain("flagOutputKey");
    expect(JSON.stringify(publicCatalog)).not.toContain("instructions");

    expect(Object.values(next.bundle.catalog as Record<string, string>)[0]).toContain(
      `/${"2".repeat(40)}/`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloaded dispatch paths allow safe nested roots and reject traversal and shell syntax", () => {
  const prefix = `pack-problems/catalog.${"a".repeat(64)}/${"b".repeat(40)}`;
  const schema = DeployCreateRequestedDetailSchema.shape.problemDir;
  expect(schema.safeParse(`${prefix}/problem.catalog/challenges/demo`).success).toBe(true);
  for (const path of [
    "../challenges/demo",
    "./challenges/demo",
    "a//challenges/demo",
    "a;/challenges/demo",
    "a\\b/challenges/demo",
  ])
    expect(schema.safeParse(`${prefix}/${path}`).success).toBe(false);
});

test("Cloud rejects duplicate selected identities even when an on-disk lock bypasses acquisition", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-duplicate-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/pack.git", ref: "a".repeat(40) }],
      },
      {
        fetcher: ({ destinationDir }) =>
          cpSync(
            join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
            destinationDir,
            { recursive: true },
          ),
      },
    );
    const path = join(root, ".tenkacloud/catalog-store/selected.json");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    lock.sources.push({ ...lock.sources[0], commit: "b".repeat(40) });
    lock.retained = lock.sources;
    writeFileSync(path, JSON.stringify(lock));
    expect(() => downloadedCloudCatalog(root)).toThrow("Duplicate cloud catalog problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cloud detects corrupted preparation copies and removes the failed build directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-copy-fault-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/pack.git", ref: "a".repeat(40) }],
      },
      {
        fetcher: ({ destinationDir }) =>
          cpSync(
            join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
            destinationDir,
            { recursive: true },
          ),
      },
    );
    const copy = (await vi.importActual<typeof import("node:fs")>("node:fs")).cpSync;
    const spy = vi.spyOn(fs, "cpSync").mockImplementation((source, target, options) => {
      copy(source, target, options);
      writeFileSync(join(String(target), "transfer-corruption.txt"), "damaged copy");
    });
    try {
      expect(() => downloadedCloudCatalog(root)).toThrow("Cloud catalog copy digest mismatch");
      expect(fs.readdirSync(join(root, ".tenkacloud/catalog-build"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(Object.keys(downloadedCloudCatalog(root).bundle.catalog as object)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated Cloud preparation reuses immutable roots without deleting a previous caller's staged input", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-reuse-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/pack.git", ref: "a".repeat(40) }],
      },
      {
        fetcher: ({ destinationDir }) =>
          cpSync(
            join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
            destinationDir,
            { recursive: true },
          ),
      },
    );
    const first = downloadedCloudCatalog(root);
    const second = downloadedCloudCatalog(root);
    const original = String(first.packAssets[0]?.problemsRootAbs);
    expect(second.packAssets[0]?.problemsRootAbs).toBe(original);
    expect(fs.readdirSync(join(root, ".tenkacloud/catalog-build"))).toHaveLength(1);
    expect(readFileSync(join(original, "tenkacloud-pack.json"), "utf8")).toContain(
      "sample-aws-flag",
    );
    writeFileSync(join(original, "corruption.txt"), "do not silently overwrite active asset");
    expect(() => downloadedCloudCatalog(root)).toThrow("prepared catalog digest mismatch");
    expect(fs.readdirSync(join(root, ".tenkacloud/catalog-build"))).toHaveLength(1);
    expect(readFileSync(join(original, "corruption.txt"), "utf8")).toContain(
      "do not silently overwrite",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloaded Cloud catalog retains crypto-tagged problems and their source asset", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-tag-content-"));
  try {
    downloadCatalog(
      root,
      {
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/pack.git", ref: "a".repeat(40) }],
      },
      {
        fetcher: ({ destinationDir }) => {
          cpSync(
            join(repository, "scripts/problem-pack/test/fixtures/sample-aws-flag"),
            destinationDir,
            { recursive: true },
          );
          const path = join(destinationDir, "problems/challenges/sample-flag/metadata.json");
          const metadata = JSON.parse(readFileSync(path, "utf8"));
          writeFileSync(path, JSON.stringify({ ...metadata, tags: ["cryptography"] }));
        },
      },
    );
    const prepared = downloadedCloudCatalog(root);
    expect(prepared.bundle.catalog).toHaveProperty("sample-flag");
    expect(prepared.bundle.scoring).toHaveProperty("sample-flag");
    expect(prepared.packAssets).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
