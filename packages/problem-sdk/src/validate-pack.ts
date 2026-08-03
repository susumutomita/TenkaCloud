/**
 * [Problem SDK / Issue #2106 ← #2088] Standalone, offline pack validator — the
 * single source of truth. The infra copy re-exports `validatePackDirectory` and
 * its result/diagnostic types so existing callers (pack-cli, snapshot) are
 * unchanged.
 *
 * `validatePackDirectory(dir)` is a local author tool: it reads a problem-pack
 * directory and reports author-facing diagnostics with NO CDK synth, no cloud
 * credentials, no network. It performs only read-only filesystem I/O inside the
 * pack root — the ONLY filesystem-reading function in the SDK, and pure-
 * deterministic given the directory contents.
 *
 * Responsibilities (the manifest parser is intentionally I/O-free, so these all
 * live here):
 *   - read + schema-validate `<dir>/tenkacloud-pack.json` (via `parsePackManifest`)
 *   - safe path resolution: every resolved path stays strictly inside the pack root
 *   - discover `<problemsRoot>/<category>/<id>/metadata.json`
 *   - reuse the pure metadata / runtime / scoring / endpoint / phase / disruption validators
 *   - unique problem ids within the pack
 *   - the manifest's declared runtimes must cover every runtime the problems use
 *   - every referenced artifact path stays inside the pack root
 *
 * Diagnostics are stable-sorted so equal input yields byte-identical output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  isCompositeRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import type { PackDiagnostic } from "./diagnostics.js";
import { type PackManifest, parsePackManifest } from "./manifest.js";
import { validateMetadataSections } from "./metadata-sections.js";
import type { PackProblem } from "./problem-metadata.js";
import { isExistingDirectory, readDirNames, resolveInside } from "./safe-path.js";

// PackDiagnostic is re-exported for direct importers of this module (it is the
// element type of `PackValidationResult.diagnostics`). `PackDiagnosticCode` is
// deliberately NOT re-exported here — every consumer takes it from
// `./diagnostics.js` / `/internal`, so the extra path was knip-flagged dead (#2866).
export type { PackDiagnostic } from "./diagnostics.js";

/** The pack manifest filename — the only entrypoint of a problem pack. */
export const PACK_MANIFEST_FILENAME = "tenkacloud-pack.json";

/** The structured result of {@link validatePackDirectory}. */
export interface PackValidationResult {
  readonly ok: boolean;
  /** Diagnostics, stable-sorted. Empty iff `ok` is true. */
  readonly diagnostics: readonly PackDiagnostic[];
  /** The validated manifest, when the manifest parsed; otherwise undefined. */
  readonly manifest?: PackManifest;
  /** Discovered problem ids, sorted. Empty when discovery did not run. */
  readonly problemIds: readonly string[];
  /** Discovered problems with pack-relative directories, sorted by problem id. */
  readonly problems: readonly PackProblem[];
}

/** Internal: a discovered problem with its already-parsed metadata. */
interface DiscoveredProblem {
  readonly id: string;
  /** Pack-relative directory, e.g. `problems/challenges/hello-world`. */
  readonly relDir: string;
  /** Pack-relative metadata file path. */
  readonly metadataFile: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Validate a problem-pack directory and return structured, stable-sorted
 * diagnostics. Never throws on malformed packs — every failure is a diagnostic.
 */
export function validatePackDirectory(dir: string): PackValidationResult {
  const packRoot = path.resolve(dir);
  const diagnostics: PackDiagnostic[] = [];

  if (!isExistingDirectory(packRoot)) {
    diagnostics.push({
      code: "PACK_DIR_MISSING",
      file: ".",
      path: "",
      message: `Pack directory '${dir}' does not exist. Pass the directory that contains ${PACK_MANIFEST_FILENAME}.`,
    });
    return finalize(diagnostics, undefined, [], []);
  }

  const manifestResult = readManifest(packRoot, diagnostics);
  if (!manifestResult) {
    return finalize(diagnostics, undefined, [], []);
  }
  const manifest = manifestResult;

  const problemsRootAbs = resolveInside(packRoot, manifest.problemsRoot);
  if (!problemsRootAbs) {
    diagnostics.push({
      code: "PROBLEMS_ROOT_TRAVERSAL",
      file: PACK_MANIFEST_FILENAME,
      path: "problemsRoot",
      message: `problemsRoot '${manifest.problemsRoot}' must resolve inside the pack root (no '..', absolute paths, or escaping symlinks).`,
    });
    return finalize(diagnostics, manifest, [], []);
  }
  if (!isExistingDirectory(problemsRootAbs)) {
    diagnostics.push({
      code: "PROBLEMS_ROOT_MISSING",
      file: PACK_MANIFEST_FILENAME,
      path: "problemsRoot",
      message: `problemsRoot '${manifest.problemsRoot}' was not found under the pack root.`,
    });
    return finalize(diagnostics, manifest, [], []);
  }

  const problems = discoverProblems(packRoot, problemsRootAbs, manifest.problemsRoot, diagnostics);

  checkUniqueIds(problems, diagnostics);
  for (const problem of problems) {
    validateProblem(packRoot, problem, manifest, diagnostics);
  }

  const problemIds = [...new Set(problems.map((p) => p.id))].sort((a, b) => a.localeCompare(b));
  const packProblems = problems
    .map((problem) => ({ id: problem.id, relDir: problem.relDir }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.relDir.localeCompare(b.relDir));
  return finalize(diagnostics, manifest, problemIds, packProblems);
}

function readManifest(packRoot: string, diagnostics: PackDiagnostic[]): PackManifest | undefined {
  const manifestPath = path.join(packRoot, PACK_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    diagnostics.push({
      code: "MANIFEST_MISSING",
      file: PACK_MANIFEST_FILENAME,
      path: "",
      message: `No ${PACK_MANIFEST_FILENAME} found in the pack directory. Every pack must declare one at its root.`,
    });
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    diagnostics.push({
      code: "MANIFEST_UNREADABLE",
      file: PACK_MANIFEST_FILENAME,
      path: "",
      message: `Could not read ${PACK_MANIFEST_FILENAME}: ${(err as Error).message}.`,
    });
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    diagnostics.push({
      code: "MANIFEST_INVALID",
      file: PACK_MANIFEST_FILENAME,
      path: "",
      message: `${PACK_MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}.`,
    });
    return undefined;
  }
  const result = parsePackManifest(parsedJson);
  if (!result.ok) {
    for (const issue of result.issues) {
      diagnostics.push({
        code: "MANIFEST_INVALID",
        file: PACK_MANIFEST_FILENAME,
        path: issue.path,
        message: issue.message,
      });
    }
    return undefined;
  }
  return result.manifest;
}

function discoverProblems(
  packRoot: string,
  problemsRootAbs: string,
  problemsRootRel: string,
  diagnostics: PackDiagnostic[],
): DiscoveredProblem[] {
  const problems: DiscoveredProblem[] = [];
  for (const category of readDirNames(problemsRootAbs)) {
    // Resolve through realpath (not lexical join) so a symlinked category dir
    // that escapes the pack root is rejected rather than traversed.
    const categoryAbs = resolveInside(problemsRootAbs, category, packRoot);
    if (!categoryAbs || !isExistingDirectory(categoryAbs)) continue;
    for (const problemDir of readDirNames(categoryAbs)) {
      const discovered = discoverOneProblem(
        packRoot,
        categoryAbs,
        path.join(problemsRootRel, category, problemDir),
        problemDir,
        diagnostics,
      );
      if (discovered) problems.push(discovered);
    }
  }
  // Stable order so diagnostics + problemIds are deterministic.
  return problems.sort((a, b) => a.metadataFile.localeCompare(b.metadataFile));
}

function discoverOneProblem(
  packRoot: string,
  categoryAbs: string,
  relDir: string,
  problemDir: string,
  diagnostics: PackDiagnostic[],
): DiscoveredProblem | undefined {
  // Each path segment is realpath-checked against the pack root, so a symlinked
  // problem dir or metadata.json that points outside the pack is skipped.
  const problemAbs = resolveInside(categoryAbs, problemDir, packRoot);
  if (!problemAbs || !isExistingDirectory(problemAbs)) return undefined;
  const metadataAbs = resolveInside(problemAbs, "metadata.json", packRoot);
  if (!metadataAbs || !fs.existsSync(metadataAbs)) return undefined;
  const metadataFile = path.join(relDir, "metadata.json");
  return readProblemMetadata(metadataAbs, relDir, metadataFile, diagnostics);
}

function readProblemMetadata(
  metadataAbs: string,
  relDir: string,
  metadataFile: string,
  diagnostics: PackDiagnostic[],
): DiscoveredProblem | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(metadataAbs, "utf-8");
  } catch (err) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: metadataFile,
      path: "",
      message: `Could not read metadata.json: ${(err as Error).message}.`,
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: metadataFile,
      path: "",
      message: `metadata.json is not valid JSON: ${(err as Error).message}.`,
    });
    return undefined;
  }
  if (!isRecord(parsed)) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: metadataFile,
      path: "",
      message: "metadata.json must be a JSON object.",
    });
    return undefined;
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: metadataFile,
      path: "id",
      message: "metadata.json must declare a non-empty string 'id'.",
    });
    return undefined;
  }
  return { id: parsed.id, relDir, metadataFile, metadata: parsed };
}

function checkUniqueIds(
  problems: readonly DiscoveredProblem[],
  diagnostics: PackDiagnostic[],
): void {
  const byId = new Map<string, DiscoveredProblem[]>();
  for (const problem of problems) {
    const list = byId.get(problem.id) ?? [];
    list.push(problem);
    byId.set(problem.id, list);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    // Report every duplicate occurrence except the first so the author sees each clashing file.
    for (const problem of list.slice(1)) {
      diagnostics.push({
        code: "DUPLICATE_PROBLEM_ID",
        file: problem.metadataFile,
        path: "id",
        message: `Problem id '${id}' is declared by more than one problem (${list
          .map((p) => p.relDir)
          .join(", ")}). Each id must be unique within the pack.`,
      });
    }
  }
}

function validateProblem(
  packRoot: string,
  problem: DiscoveredProblem,
  manifest: PackManifest,
  diagnostics: PackDiagnostic[],
): void {
  validateMetadataSections(problem, diagnostics);
  const runtime = normalizeProblemRuntime(problem, diagnostics);
  if (!runtime) return;
  validateRuntimeArtifacts(packRoot, problem, runtime, diagnostics);
  validateRuntimeDeclared(problem, runtime, manifest, diagnostics);
}

function normalizeProblemRuntime(
  problem: DiscoveredProblem,
  diagnostics: PackDiagnostic[],
): ProblemRuntimeDescriptor | undefined {
  try {
    const runtime = normalizeRuntime({
      id: problem.id,
      runtime: problem.metadata.runtime,
      cfnTemplate: problem.metadata.cfnTemplate,
    });
    if (!runtime) {
      diagnostics.push({
        code: "METADATA_INVALID",
        file: problem.metadataFile,
        path: "runtime",
        message: "runtime is present but malformed: provider/engine/entry must all be strings.",
      });
      return undefined;
    }
    return runtime;
  } catch (err) {
    // RuntimeValidationError (e.g. an invalid composite runtime) — surface its issues.
    diagnostics.push({
      code: "METADATA_INVALID",
      file: problem.metadataFile,
      path: "runtime",
      message: `runtime declaration is invalid: ${(err as Error).message}.`,
    });
    return undefined;
  }
}

/** Every entry path a runtime references must resolve to a real file inside the pack root. */
function validateRuntimeArtifacts(
  packRoot: string,
  problem: DiscoveredProblem,
  runtime: ProblemRuntimeDescriptor,
  diagnostics: PackDiagnostic[],
): void {
  if (isCompositeRuntime(runtime)) {
    runtime.targets.forEach((target, index) => {
      checkArtifact(
        packRoot,
        problem,
        target.entry,
        `runtime.targets[${index}].entry`,
        diagnostics,
      );
    });
    return;
  }
  // Single runtime: the entry comes from `runtime.entry` (when a runtime object
  // is declared) or from `cfnTemplate` / the default deploy-body filename.
  const fieldPath = isRecord(problem.metadata.runtime) ? "runtime.entry" : "cfnTemplate";
  checkArtifact(packRoot, problem, runtime.entry, fieldPath, diagnostics);
}

function checkArtifact(
  packRoot: string,
  problem: DiscoveredProblem,
  entry: string,
  fieldPath: string,
  diagnostics: PackDiagnostic[],
): void {
  const problemDirAbs = path.join(packRoot, problem.relDir);
  const resolved = resolveInside(problemDirAbs, entry, packRoot);
  if (!resolved) {
    diagnostics.push({
      code: "ARTIFACT_TRAVERSAL",
      file: problem.metadataFile,
      path: fieldPath,
      message: `Referenced artifact '${entry}' must resolve inside the pack root (no '..', absolute paths, or escaping symlinks).`,
    });
    return;
  }
  // The artifact must be a deployable body: either a real file (a single-page
  // CFn template), or a NON-EMPTY directory module (a Terraform / Infrastructure
  // Manager / Bicep module a composite target points at). An empty directory or
  // anything else at the entry path is treated as missing, so a deploy never
  // points at nothing.
  if (!isDeployableArtifact(resolved)) {
    diagnostics.push({
      code: "ARTIFACT_MISSING",
      file: problem.metadataFile,
      path: fieldPath,
      message: `Referenced artifact '${entry}' was not found at ${path.relative(packRoot, resolved)} (expected a file or a non-empty module directory).`,
    });
  }
}

/**
 * A deployable artifact is a regular file (a single-page template) or a non-empty
 * directory module (the directory a Terraform / Infrastructure Manager / Bicep
 * composite target deploys). An empty directory is NOT deployable and is treated
 * as missing.
 */
function isDeployableArtifact(target: string): boolean {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return true;
    if (stat.isDirectory()) return directoryContainsFile(target);
    return false;
  } catch {
    return false;
  }
}

/** True when the directory tree contains at least one regular file. */
function directoryContainsFile(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFile(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** The manifest's `requiredRuntimes` must cover every (provider, engine) a problem uses. */
function validateRuntimeDeclared(
  problem: DiscoveredProblem,
  runtime: ProblemRuntimeDescriptor,
  manifest: PackManifest,
  diagnostics: PackDiagnostic[],
): void {
  const declared = new Set(manifest.requiredRuntimes.map((r) => `${r.provider}/${r.engine}`));
  const used = isCompositeRuntime(runtime)
    ? runtime.targets.map((t) => ({ provider: t.provider, engine: t.engine }))
    : [{ provider: runtime.provider, engine: runtime.engine }];
  for (const { provider, engine } of used) {
    if (!declared.has(`${provider}/${engine}`)) {
      diagnostics.push({
        code: "RUNTIME_MISMATCH",
        file: problem.metadataFile,
        path: "runtime",
        message: `Problem uses runtime '${provider}/${engine}', which is not in the manifest requiredRuntimes. Add { "provider": "${provider}", "engine": "${engine}" } to requiredRuntimes.`,
      });
    }
  }
}

function finalize(
  diagnostics: PackDiagnostic[],
  manifest: PackManifest | undefined,
  problemIds: readonly string[],
  problems: readonly PackProblem[],
): PackValidationResult {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  return {
    ok: sorted.length === 0,
    diagnostics: sorted,
    ...(manifest ? { manifest } : {}),
    problemIds,
    problems,
  };
}

function compareDiagnostics(a: PackDiagnostic, b: PackDiagnostic): number {
  return (
    a.file.localeCompare(b.file) ||
    a.path.localeCompare(b.path) ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
