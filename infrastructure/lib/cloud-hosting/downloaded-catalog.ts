import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { computeContentDigest } from "../../../packages/problem-sdk/src/content-digest.js";
import {
  catalogMetadata,
  retainedCatalogSnapshots,
  selectedCatalogSnapshots,
  withCatalogMutation,
} from "../../../scripts/problem-pack/catalog-read.js";
import { LocalCatalogSource } from "../../../scripts/problem-pack/catalog-source.js";
import type {
  PackAsset,
  ProblemsCatalogBundle,
} from "../../../scripts/problem-pack/catalog-types.js";
import { cloudCatalog } from "./catalog.js";

type Snapshot = ReturnType<typeof selectedCatalogSnapshots>[number];
function normalizeGroup(group: string): void {
  if (!existsSync(group)) return;
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    const metadata = join(group, entry.name, "metadata.json");
    if (entry.isDirectory() && existsSync(metadata))
      writeFileSync(
        metadata,
        JSON.stringify(catalogMetadata(JSON.parse(readFileSync(metadata, "utf8")))),
      );
  }
}
function prepareSource(buildRoot: string, source: Snapshot): string {
  const prepared = mkdtempSync(join(buildRoot, "source-"));
  try {
    cpSync(source.directory, prepared, { recursive: true });
    if (computeContentDigest(prepared, true) !== source.revision.digest)
      throw new Error("Cloud catalog copy digest mismatch");
    const problems = join(prepared, relative(source.directory, source.problemRoot));
    for (const category of ["challenges", "battles"]) normalizeGroup(join(problems, category));
    const digest = computeContentDigest(prepared, true);
    const reusable = join(buildRoot, `snapshot-${source.revision.digest}-${digest}`);
    if (existsSync(reusable)) {
      if (
        !lstatSync(reusable).isDirectory() ||
        lstatSync(reusable).isSymbolicLink() ||
        computeContentDigest(reusable, true) !== digest
      )
        throw new Error("Cloud prepared catalog digest mismatch");
    } else renameSync(prepared, reusable);
    return reusable;
  } finally {
    rmSync(prepared, { recursive: true, force: true });
  }
}
function sourceBundle(source: Snapshot, asset: PackAsset): ProblemsCatalogBundle {
  const root = join(asset.problemsRootAbs, relative(source.directory, source.problemRoot));
  const loaded = new LocalCatalogSource().loadBundle(root);
  const bundle = cloudCatalog(loaded);
  const catalog = bundle.catalog as Record<string, string>;
  const prefix = `pack-problems/${asset.packId}/${asset.version}`;
  return {
    ...bundle,
    catalog: Object.fromEntries(
      Object.entries(catalog).map(([id, directory]) => [
        id,
        `${prefix}/${join(relative(asset.problemsRootAbs, root), directory.slice("problems/".length)).replaceAll("\\", "/")}`,
      ]),
    ),
    provenance: Object.fromEntries(
      Object.keys(catalog).map((id) => [
        id,
        {
          source: "pack",
          packId: asset.packId,
          packVersion: source.revision.commit,
          contentDigest: source.revision.digest,
        },
      ]),
    ),
  };
}
function mergeBundles(bundles: ProblemsCatalogBundle[]): ProblemsCatalogBundle {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const bundle of bundles)
    for (const [key, value] of Object.entries(bundle)) {
      merged[key] ??= {};
      for (const [id, projection] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        if (Object.hasOwn(merged[key], id))
          throw new Error(`Duplicate cloud catalog problem: ${id}`);
        merged[key][id] = projection;
      }
    }
  return merged as unknown as ProblemsCatalogBundle;
}
/** Build only explicitly selected catalogs; keep every accepted edition's asset prefix immutable. */
export function downloadedCloudCatalog(repositoryRoot: string): {
  bundle: ProblemsCatalogBundle;
  packAssets: PackAsset[];
} {
  return withCatalogMutation(repositoryRoot, () => {
    const selected = selectedCatalogSnapshots(repositoryRoot);
    const retained = retainedCatalogSnapshots(repositoryRoot);
    const buildRoot = join(repositoryRoot, ".tenkacloud/catalog-build");
    mkdirSync(buildRoot, { recursive: true });
    const packAssets: PackAsset[] = [];
    const bundles: ProblemsCatalogBundle[] = [];
    for (const source of retained) {
      const asset = {
        packId: `catalog.${source.revision.digest}`,
        version: source.revision.commit,
        problemsRootAbs: prepareSource(buildRoot, source),
      };
      packAssets.push(asset);
      if (
        selected.some(
          (current) =>
            current.revision.commit === source.revision.commit &&
            current.revision.digest === source.revision.digest,
        )
      )
        bundles.push(sourceBundle(source, asset));
    }
    return { bundle: mergeBundles(bundles), packAssets };
  });
}
