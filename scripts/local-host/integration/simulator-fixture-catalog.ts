import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { computeContentDigest } from "../../../packages/problem-sdk/src/content-digest";
import {
  CatalogLockSchema,
  lockPath,
  selectedCatalogSnapshots,
  snapshot,
} from "../../problem-pack/catalog-read";
import { copyLocalCatalog } from "../../problem-pack/local-catalog";
import { sealSourcePermissions } from "../../problem-pack/source-permissions";
import { assertHostCatalogBuild, hostBuildDirectory } from "../build";
import { verifyHostBuildArtifacts, verifyHostBuildProvenance } from "../host-build-provenance";
import { SimulatorFixtureError } from "./simulator-fixture-process";

export const ORIGINAL_CATALOG_DIGEST =
  "6eccbc93ded675743ed12267a547b39978de14a7af0075cc99674592b097c177";
export const ORIGINAL_HELLO_TEMPLATE_HASH =
  "ad8b4fcf3f1d42475c5c2e8617d3194536810cc044a6ea166a2699cac719c8bb";

const MAX_SELECTION_BYTES = 1024 * 1024;

/** Only the known catalog path is checked; this is not isolation from concurrent same-UID writes. */
function assertCatalogDirectories(root: string, descendants: readonly string[]): void {
  let path = resolve(root);
  for (const segment of ["", ...descendants]) {
    path = join(path, segment);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new SimulatorFixtureError("Fixture catalog directories must not be symbolic links.");
  }
}

/** O_NONBLOCK prevents a substituted FIFO from blocking open; fstat rejects it before any read. */
export function readFixtureCatalogLock(path: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const entry = fstatSync(descriptor);
    if (!entry.isFile() || entry.size > MAX_SELECTION_BYTES)
      throw new Error("Not a bounded regular catalog lock");
    const bytes = Buffer.alloc(MAX_SELECTION_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_SELECTION_BYTES) throw new Error("Catalog lock exceeded its byte limit");
    return bytes.subarray(0, size).toString("utf8");
  } catch {
    throw new SimulatorFixtureError(
      "Fixture catalog selection must be a nonsymlink regular file no larger than 1 MiB.",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Validate the shared lock before normal catalog code can reread it in this same process. */
export function readFixtureCatalogSelection(root: string): string {
  try {
    assertCatalogDirectories(root, [".tenkacloud", "catalog-store"]);
  } catch {
    throw new SimulatorFixtureError(
      "Fixture catalog root, .tenkacloud and catalog-store must be nonsymlink directories.",
    );
  }
  return readFixtureCatalogLock(lockPath(root));
}

/** Verify a private snapshot copy; never restore modes or acquire into the shared catalog. */
export function copyFixtureSelection(repositoryRoot: string, root: string): string {
  const identity = readFixtureCatalogSelection(repositoryRoot);
  const selected = CatalogLockSchema.parse(JSON.parse(identity));
  if (selected.sources.some((source) => !("path" in source) || !isAbsolute(source.path)))
    throw new SimulatorFixtureError(
      "Acceptance requires an already selected local catalog with an absolute source.path; remote sources are not fetched.",
    );
  // Check every source snapshot ancestor before cpSync can traverse it.
  for (const revision of selected.sources)
    assertCatalogDirectories(repositoryRoot, [
      ".tenkacloud",
      "catalog-store",
      "snapshots",
      revision.digest,
    ]);
  mkdirSync(join(root, ".tenkacloud/catalog-store/snapshots"), { recursive: true });
  assertCatalogDirectories(root, [".tenkacloud", "catalog-store", "snapshots"]);
  for (const revision of selected.sources)
    cpSync(snapshot(repositoryRoot, revision.digest), snapshot(root, revision.digest), {
      recursive: true,
    });
  writeFileSync(lockPath(root), identity, { flag: "wx", mode: 0o600 });
  selectedCatalogSnapshots(root);
  return identity;
}

/** Use the acquisition's exact filter/mode manifest/digest before every reacquisition. */
export function verifyFixtureSources(root: string, scratch: string, identity: string): void {
  if (readFixtureCatalogSelection(root) !== identity)
    throw new SimulatorFixtureError("The selected catalog identity changed during acceptance.");
  const selected = selectedCatalogSnapshots(root);
  for (const [index, { revision }] of selected.entries()) {
    if (!("path" in revision))
      throw new SimulatorFixtureError("Acceptance cannot reacquire a remote catalog.");
    const destination = join(scratch, `source-check-${String(index)}`);
    try {
      copyLocalCatalog(revision.path, destination);
      sealSourcePermissions(destination);
      if (computeContentDigest(destination, true) !== revision.digest)
        throw new SimulatorFixtureError(
          "The original local catalog has changed since selection; acceptance stopped before reacquisition.",
        );
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  }
}

export function prepareFixtureCatalog(repositoryRoot: string, root: string, scratch: string) {
  const requested = CatalogLockSchema.parse(
    JSON.parse(readFixtureCatalogSelection(repositoryRoot)),
  );
  if (requested.sources.length !== 1 || requested.sources[0]?.digest !== ORIGINAL_CATALOG_DIGEST)
    throw new SimulatorFixtureError("Acceptance requires the pinned original Challenge snapshot.");
  const identity = copyFixtureSelection(repositoryRoot, root);
  const selected = selectedCatalogSnapshots(root);
  const original = selected[0];
  if (selected.length !== 1 || original?.revision.digest !== ORIGINAL_CATALOG_DIGEST)
    throw new SimulatorFixtureError("Acceptance requires the pinned original Challenge snapshot.");
  const template = join(original.problemRoot, "challenges/hello-world/template.yaml");
  const templateHash = createHash("sha256").update(readFileSync(template)).digest("hex");
  if (templateHash !== ORIGINAL_HELLO_TEMPLATE_HASH)
    throw new SimulatorFixtureError("The selected HelloWorld template is not the pinned original.");
  verifyFixtureSources(root, scratch, identity);
  try {
    assertHostCatalogBuild(repositoryRoot);
    verifyHostBuildProvenance(repositoryRoot);
  } catch {
    throw new SimulatorFixtureError(
      "Host interfaces are missing, stale or corrupted; run bun run build:host --acceptance-provenance.",
    );
  }
  for (const app of ["application-admin-console", "participant-portal"] as const) {
    if (!existsSync(join(hostBuildDirectory(repositoryRoot, app), "host.html")))
      throw new SimulatorFixtureError("Build both local host interfaces before acceptance.");
  }
  cpSync(join(repositoryRoot, ".tenkacloud/host-build"), join(root, ".tenkacloud/host-build"), {
    recursive: true,
  });
  const provenance = verifyHostBuildArtifacts(root);
  const sources = selected.map(({ revision }) => {
    if (!("path" in revision)) throw new SimulatorFixtureError("Local catalog source required.");
    return { path: revision.path };
  });
  const configFile = join(scratch, "catalog-sources.json");
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, sources }), { mode: 0o600 });
  return {
    identity,
    configFile,
    catalogDigest: original.revision.digest,
    templateHash,
    provenance,
  };
}
