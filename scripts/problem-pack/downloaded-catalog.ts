import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Ajv from "ajv";
import { z } from "zod";
import platformPackage from "../../package.json";
import {
  CatalogLockSchema,
  catalogMetadata,
  lockPath,
  type Revision,
  SelectionSchema,
  selectedCatalogRoots,
  snapshot,
  store,
  withCatalogMutation,
} from "./catalog-read.js";
import schema from "./catalog-schema.json";
import { realGitArchiveFetcher } from "./git-fetcher.js";
import { type GitArchiveFetcher, parseGitSource } from "./git-source.js";
import { satisfiesCoreRange } from "./manifest.js";
import { computeContentDigest } from "./snapshot.js";
import { restoreSourcePermissions, sealSourcePermissions } from "./source-permissions.js";
import { validatePackDirectory } from "./validate-pack.js";

const dummyCommit = "0".repeat(40);
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("uri", {
  validate: (value: string) => {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  },
});
const validateMetadata = ajv.compile(schema);

/** Resolve only during explicit acquisition. Runtime uses selected.json, never a remote ref. */
export function resolveCatalogRef(url: string, ref: string): string {
  const parsed = parseGitSource({ url, commit: dummyCommit });
  if (!parsed.ok) throw new Error(parsed.message);
  if (/^[a-f0-9]{40}$/iu.test(ref)) return ref.toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(ref) || ref.includes(".."))
    throw new Error("Invalid catalog ref");
  let patterns = [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  if (ref === "HEAD") patterns = ["HEAD"];
  else if (ref.startsWith("refs/heads/")) patterns = [ref];
  else if (ref.startsWith("refs/tags/")) patterns = [ref, `${ref}^{}`];
  const output = execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- hardened HTTPS Git transport, fixed arguments and disabled hooks
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "ls-remote",
      "--",
      url,
      ...patterns,
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  );
  const rows = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
  const peeled = rows.find((row) => row[1]?.endsWith("^{}"));
  const commits = new Set(
    rows
      .filter((row) => !row[1]?.startsWith("refs/tags/") || !peeled || row === peeled)
      .map((row) => row[0]),
  );
  if (commits.size !== 1)
    throw new Error("Catalog ref is missing or ambiguous; specify a full commit");
  return z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse([...commits][0]);
}

function directories(root: string): string[] {
  return ["challenges", "battles"].flatMap((category) =>
    existsSync(join(root, category))
      ? readdirSync(join(root, category), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, category, entry.name))
      : [],
  );
}
function validateTree(root: string): void {
  const entries = directories(root);
  if (!entries.length) throw new Error("Catalog contains no problems");
  const ids = new Set<string>();
  for (const directory of entries) {
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as {
      id?: unknown;
      name?: unknown;
    };
    if (!validateMetadata(metadata))
      throw new Error(
        `Invalid catalog metadata: ${directory}: ${ajv.errorsText(validateMetadata.errors)}`,
      );
    if (metadata.id !== basename(directory) || typeof metadata.name !== "string")
      throw new Error(`Invalid catalog metadata: ${directory}`);
    if (ids.has(String(metadata.id)))
      throw new Error(`Duplicate catalog problem ID: ${String(metadata.id)}`);
    ids.add(String(metadata.id));
    for (const file of ["README.md", "README.ja.md"])
      if (!existsSync(join(directory, file))) throw new Error(`Missing ${file}: ${directory}`);
  }
}
function problemsRoot(directory: string): string {
  if (!existsSync(join(directory, "tenkacloud-pack.json"))) {
    validateTree(directory);
    return ".";
  }
  const validation = validatePackDirectory(directory);
  if (!validation.ok || !validation.manifest)
    throw new Error(JSON.stringify(validation.diagnostics));
  if (!satisfiesCoreRange(platformPackage.version, validation.manifest.core))
    throw new Error(
      `Catalog requires core ${validation.manifest.core}; this platform is ${platformPackage.version}`,
    );
  return validation.manifest.problemsRoot;
}

function validateCatalogIdentity(root: string): void {
  const problems = directories(root);
  if (!problems.length) throw new Error("Catalog contains no problem metadata");
  for (const directory of problems) {
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
    if (metadata.id !== basename(directory))
      throw new Error("Catalog metadata identity must match its directory");
  }
}

function saveSnapshot(scratch: string, destination: string, digest: string, root: string): void {
  if (existsSync(destination)) {
    if (computeContentDigest(destination, true) !== digest)
      throw new Error("Catalog snapshot digest mismatch");
    restoreSourcePermissions(destination);
    return;
  }
  const incoming = mkdtempSync(join(store(root), "snapshots/.incoming-"));
  try {
    cpSync(scratch, incoming, { recursive: true });
    restoreSourcePermissions(incoming);
    if (computeContentDigest(incoming, true) !== digest)
      throw new Error("Catalog copy digest mismatch");
    renameSync(incoming, destination);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

/** Download and validate bytes only. No package scripts, builds, plugins or runtime start. */
export function downloadCatalog(
  root: string,
  config: unknown,
  deps: { fetcher?: GitArchiveFetcher; resolveRef?: typeof resolveCatalogRef } = {},
): void {
  withCatalogMutation(root, () => downloadCatalogInternal(root, config, deps));
}
function downloadCatalogInternal(
  root: string,
  config: unknown,
  deps: { fetcher?: GitArchiveFetcher; resolveRef?: typeof resolveCatalogRef },
): void {
  const selection = SelectionSchema.parse(config);
  const revisions: Revision[] = [];
  for (const source of selection.sources) {
    const commit = (deps.resolveRef ?? resolveCatalogRef)(source.url, source.ref);
    const parsed = parseGitSource({ url: source.url, commit, subdir: source.subdir });
    if (!parsed.ok) throw new Error(parsed.message);
    const scratch = mkdtempSync(join(tmpdir(), "tenka-catalog-"));
    try {
      (deps.fetcher ?? realGitArchiveFetcher)({
        ...parsed.source,
        destinationDir: scratch,
        rejectLinks: true,
      });
      const relativeRoot = problemsRoot(scratch);
      validateCatalogIdentity(join(scratch, relativeRoot));
      sealSourcePermissions(scratch);
      const digest = computeContentDigest(scratch, true);
      const destination = snapshot(root, digest);
      mkdirSync(join(store(root), "snapshots"), { recursive: true });
      saveSnapshot(scratch, destination, digest, root);
      revisions.push({ ...source, commit, digest, problemsRoot: relativeRoot });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // Reject cross-pack conflicts before changing the selected lock or browser view.
  const ids = new Set<string>();
  for (const revision of revisions)
    for (const directory of directories(
      join(snapshot(root, revision.digest), revision.problemsRoot),
    )) {
      const id = basename(directory);
      if (ids.has(id)) throw new Error(`Duplicate catalog problem ID: ${id}`);
      ids.add(id);
    }
  const previous = existsSync(lockPath(root))
    ? CatalogLockSchema.parse(JSON.parse(readFileSync(lockPath(root), "utf8")))
    : undefined;
  const retained = [
    ...new Map(
      [...(previous?.retained ?? previous?.sources ?? []), ...revisions].map((entry) => [
        `${entry.commit}:${entry.digest}`,
        entry,
      ]),
    ).values(),
  ];
  const selected = CatalogLockSchema.parse({ schemaVersion: 1, sources: revisions, retained });
  const transaction = mkdtempSync(join(store(root), ".selection-"));
  const temporary = join(transaction, "selected.json");
  writeFileSync(temporary, `${JSON.stringify(selected, null, 2)}\n`);
  try {
    renameSync(temporary, lockPath(root));
  } finally {
    rmSync(transaction, { recursive: true, force: true });
  }
}

/** Explicit build preparation. Sources used by saved Docker jobs stay in catalog-store. */
export function materializeCatalog(root: string): void {
  withCatalogMutation(root, () => materializeCatalogInternal(root));
}
function materializeCatalogInternal(root: string): void {
  const roots = selectedCatalogRoots(root);
  const staging = mkdtempSync(join(root, ".catalog-view-"));
  try {
    const ids = new Set<string>();
    for (const catalog of roots)
      for (const directory of directories(catalog)) {
        const id = basename(directory);
        if (ids.has(id)) throw new Error(`Duplicate catalog problem ID: ${id}`);
        ids.add(id);
        const destination = join(staging, basename(resolve(directory, "..")), id);
        cpSync(directory, destination, { recursive: true });
        const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
        writeFileSync(
          join(destination, "metadata.json"),
          `${JSON.stringify(catalogMetadata(metadata), null, 2)}\n`,
        );
      }
    writeFileSync(join(staging, "SCHEMA.json"), `${JSON.stringify(schema, null, 2)}\n`);
    writeFileSync(join(staging, ".tenkacloud-catalog-view.json"), readFileSync(lockPath(root)));
    const view = join(root, "problems");
    if (existsSync(join(view, ".git")))
      throw new Error(
        "Preserve and remove the old submodule checkout before preparing the downloaded catalog",
      );
    if (
      existsSync(view) &&
      readdirSync(view).length &&
      !existsSync(join(view, ".tenkacloud-catalog-view.json"))
    )
      throw new Error(
        "Existing problem files are not a generated catalog view; preserve them before preparing",
      );
    const previous = join(root, ".catalog-view-previous");
    if (existsSync(previous))
      throw new Error("A previous catalog view swap needs recovery before preparing");
    const hadView = existsSync(view);
    if (hadView) renameSync(view, previous);
    try {
      renameSync(staging, view);
    } catch (error) {
      if (hadView) renameSync(previous, view);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
