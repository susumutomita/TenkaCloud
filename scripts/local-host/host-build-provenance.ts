import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { CatalogLockSchema } from "../problem-pack/catalog-read";
import { reviewedCoordinationPaths } from "./coordination-catalog";

const APPS = ["application-admin-console", "participant-portal"] as const;
const PACKAGES = [
  "auth-client",
  "format",
  "portal-contracts",
  "portal-plugin-sdk",
  "problem-cost",
  "problem-runtime",
  "problem-sdk",
  "web-kit",
  "coordination-plugin-sdk",
];
const BUILD_ROOT = ".tenkacloud/host-build";
const MANIFEST = `${BUILD_ROOT}/provenance.json`;
const CATALOG_LOCK = ".tenkacloud/catalog-store/selected.json";
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".wasm",
  ".html",
]);
const EXCLUDED_NAMES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  "secrets",
  "credentials",
]);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);
const ProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFingerprint: SHA256,
    artifacts: z.array(z.object({ path: z.string(), sha256: SHA256 }).strict()).min(2),
  })
  .strict();
export type HostBuildProvenance = z.infer<typeof ProvenanceSchema>;

/** Check every ancestor inside the checkout before reading, including dangling links. */
function checkedPath(root: string, relative: string, optional = false): string | undefined {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
    throw new Error("Invalid host-build provenance path");
  let target = resolve(root);
  if (lstatSync(target).isSymbolicLink()) throw new Error("Host-build root cannot be a symlink");
  for (const part of parts) {
    target = join(target, part);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) {
      if (optional) return undefined;
      throw new Error(`Host-build provenance input is missing: ${relative}`);
    }
    if (stat.isSymbolicLink())
      throw new Error(`Host-build provenance rejects symlinks: ${relative}`);
  }
  return target;
}

function fileHash(root: string, relative: string): string {
  const file = checkedPath(root, relative);
  if (!file || !lstatSync(file).isFile()) throw new Error(`Expected host-build file: ${relative}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sourceName(name: string): boolean {
  return (
    !name.startsWith(".") &&
    !EXCLUDED_NAMES.has(name) &&
    !/\.(?:test|spec)\.[^.]+$/u.test(name) &&
    !/^(?:credentials?|secrets?)(?:[._-]|$)/iu.test(name) &&
    !/\.(?:pem|key|p12|pfx|kdbx)$/iu.test(name) &&
    !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(name)
  );
}

/** Only named source trees are walked; never the checkout, home, node_modules or runtime data. */
function sourceTree(root: string, relative: string, files: Set<string>, optional = false): void {
  const directory = checkedPath(root, relative, optional);
  if (!directory) return;
  if (!lstatSync(directory).isDirectory())
    throw new Error(`Expected source directory: ${relative}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!sourceName(entry.name)) continue;
    const path = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Host-build provenance rejects symlinks: ${path}`);
    if (entry.isDirectory()) sourceTree(root, path, files);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.add(path);
  }
}

function optionalFile(root: string, relative: string, files: Set<string>): void {
  if (checkedPath(root, relative, true)) files.add(relative);
}

function catalogInputs(root: string, files: Set<string>): void {
  const lock = checkedPath(root, CATALOG_LOCK);
  if (!lock) throw new Error("Missing catalog lock");
  const selection = CatalogLockSchema.parse(JSON.parse(readFileSync(lock, "utf8")));
  const revisions = [...selection.sources, ...(selection.retained ?? [])];
  // The lock binds immutable catalog identities; also hash the actual browser input bytes.
  const roots = new Set(
    revisions.map((revision) => {
      const base = `.tenkacloud/catalog-store/snapshots/${revision.digest}`;
      return revision.problemsRoot === "." ? base : `${base}/${revision.problemsRoot}`;
    }),
  );
  roots.add("problems"); // Generated metadata controls the host's public-problem discovery.
  for (const catalog of roots) {
    checkedPath(root, catalog);
    for (const category of ["challenges", "battles"])
      catalogCategoryInputs(root, catalog, category, files);
  }
}

function catalogCategoryInputs(
  root: string,
  catalog: string,
  category: string,
  files: Set<string>,
): void {
  const directory = checkedPath(root, `${catalog}/${category}`, true);
  if (!directory) return;
  for (const name of readdirSync(directory)) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name) || !sourceName(name)) continue;
    const problem = `${catalog}/${category}/${name}`;
    for (const file of ["metadata.json", "diagram.svg", "diagram.en.svg"])
      optionalFile(root, `${problem}/${file}`, files);
    if (catalog === "problems" || !reviewedCoordinationPaths.includes(`${category}/${name}`))
      continue;
    sourceTree(root, `${problem}/portal`, files, true);
    if (name === "crypto-battle" || name === "ac26-crypto-battle")
      sourceTree(root, `${problem}/game/src`, files, true);
  }
}

/** Source/dependency-lock identity, independent of timestamps and absolute checkout location.
 * This is build freshness evidence, not a signed attestation of installed dependencies.
 * Ambient environment files and unrelated untracked files are deliberately not collected.
 */
export function hostBuildSourceFingerprint(repositoryRoot: string): string {
  const files = new Set([
    "package.json",
    "bun.lock",
    CATALOG_LOCK,
    "scripts/local-host/build.ts",
    "scripts/local-host/host-build-provenance.ts",
    "scripts/local-host/browser-metadata.ts",
    "scripts/local-host/browser-public-metadata.ts",
    "scripts/local-host/coordination-catalog.ts",
    "scripts/problem-pack/catalog-read.ts",
    "scripts/problem-pack/source-permissions.ts",
    "scripts/problem-pack/downloaded-catalog.ts",
  ]);
  for (const app of APPS) {
    const base = `apps/${app}`;
    for (const file of [
      "package.json",
      "host.html",
      "vite.config.ts",
      "vite.host.config.ts",
      "tsconfig.json",
    ])
      files.add(`${base}/${file}`);
    sourceTree(repositoryRoot, `${base}/src`, files);
  }
  files.add("apps/application-admin-console/catalog-projection.ts");
  sourceTree(repositoryRoot, "apps/participant-portal/build", files);
  for (const name of PACKAGES) {
    files.add(`packages/${name}/package.json`);
    files.add(`packages/${name}/tsconfig.json`);
    sourceTree(repositoryRoot, `packages/${name}/src`, files);
  }
  catalogInputs(repositoryRoot, files);
  const inputs = [...files]
    .sort((left, right) => (left < right ? -1 : 1))
    .map((path) => ({ path, sha256: fileHash(repositoryRoot, path) }));
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

function artifactTree(root: string, relative: string): HostBuildProvenance["artifacts"] {
  const directory = checkedPath(root, `${BUILD_ROOT}/${relative}`);
  if (!directory || !lstatSync(directory).isDirectory())
    throw new Error("Missing host-build directory");
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Host-build artifact is a symlink: ${path}`);
    if (entry.isDirectory()) return artifactTree(root, path);
    return [{ path, sha256: fileHash(root, `${BUILD_ROOT}/${path}`) }];
  });
}

function artifacts(root: string): HostBuildProvenance["artifacts"] {
  for (const app of APPS) fileHash(root, `${BUILD_ROOT}/${app}/host.html`);
  return APPS.flatMap((app) => artifactTree(root, app)).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Called only after both Vite builds succeed. Refuse to bless a source change mid-build. */
export function writeHostBuildProvenance(repositoryRoot: string, sourceFingerprint: string): void {
  if (hostBuildSourceFingerprint(repositoryRoot) !== sourceFingerprint)
    throw new Error("Host interface sources changed during the build; rebuild before starting");
  const manifest: HostBuildProvenance = {
    schemaVersion: 1,
    sourceFingerprint,
    artifacts: artifacts(repositoryRoot),
  };
  const target = checkedPath(repositoryRoot, MANIFEST, true) ?? join(repositoryRoot, MANIFEST);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Validate a copied build without requiring app source trees in its private runtime. */
export function verifyHostBuildArtifacts(repositoryRoot: string): HostBuildProvenance {
  const manifestPath = checkedPath(repositoryRoot, MANIFEST, true);
  if (!manifestPath)
    throw new Error(
      "Host-build provenance is missing; run bun run build:host --acceptance-provenance",
    );
  const manifest = ProvenanceSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  // Derive paths from disk, never follow paths supplied by the manifest. Also catches additions.
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(artifacts(repositoryRoot)))
    throw new Error(
      "Host-build artifacts differ from their provenance; run bun run build:host --acceptance-provenance",
    );
  return manifest;
}

/** Opt-in acceptance preflight. Ordinary --no-build startup intentionally keeps its old contract. */
export function verifyHostBuildProvenance(repositoryRoot: string): HostBuildProvenance {
  const manifest = verifyHostBuildArtifacts(repositoryRoot);
  if (manifest.sourceFingerprint !== hostBuildSourceFingerprint(repositoryRoot))
    throw new Error(
      "Host interfaces are stale for current source or lockfile; run bun run build:host --acceptance-provenance",
    );
  return manifest;
}
