import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { downloadCatalog } from "../../../scripts/problem-pack/downloaded-catalog.js";
import { downloadedCloudCatalog } from "../../lib/cloud-hosting/downloaded-catalog.js";
import { buildCloudExecutionArtifacts } from "../../lib/cloud-hosting/execution-artifacts.js";
import { DeployCreateRequestedDetailSchema } from "../../lib/problem-deploy/handlers/shared/events.js";

const repository = resolve(import.meta.dirname, "../../..");
test("Cloud selects only requested sources and retains immutable source roots and old commit prefixes", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-download-"));
  const config = (commit: string) => ({
    schemaVersion: 1,
    sources: [{ url: "https://example.invalid/aws.git", ref: commit }],
  });
  const fetcher = (request: { destinationDir: string }) => {
    cpSync(join(repository, "packs/sample-aws-flag"), request.destinationDir, { recursive: true });
    mkdirSync(join(request.destinationDir, "shared"));
    writeFileSync(join(request.destinationDir, "shared/input.txt"), "retained root shared input");
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
