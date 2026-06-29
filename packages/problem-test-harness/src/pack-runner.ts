/**
 * [Problem Test Harness / Issue #2107] Run a problem pack's local tests from disk.
 *
 * `runPackTests(dir)` discovers a pack via the SDK `validatePackDirectory` (the
 * single validation source), loads each problem's declared JSON fixtures from
 * `<problem>/tests/*.json`, and runs them through the pure harness. It performs
 * ONLY read-only JSON reads inside the pack root — it never synthesizes IaC,
 * runs a Pack's shell, evaluates portal/coordination code, or makes a real HTTP
 * probe.
 *
 * Fixtures are pure data (JSON), so an external pack adds tests WITHOUT importing
 * any platform handler, mock, or the harness itself. A problem that declares
 * scoring MUST ship a `tests/` directory with at least one case; a deploy-only
 * problem may omit it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validatePackDirectory } from "@tenkacloud/problem-sdk";
import { runHarness } from "./run-harness.js";
import type { HarnessResult, ProblemTestCase, ProblemTestResult } from "./types.js";
import { HarnessError } from "./types.js";

const TESTS_DIRNAME = "tests";
const METADATA_FILENAME = "metadata.json";

/**
 * Run a pack's local tests. Throws {@link HarnessError} (→ exit 2) for a
 * harness/tool error: a missing pack directory, an invalid pack, an unreadable or
 * malformed fixture file, or a scoring problem that ships no `tests/` directory.
 * A genuine assertion failure is NOT thrown — it is reported as `ok: false`.
 */
export function runPackTests(dir: string): HarnessResult {
  const validation = validatePackDirectory(dir);
  if (!validation.ok || !validation.manifest) {
    throw new HarnessError(
      `Pack at '${dir}' is not valid; fix the validation diagnostics before running tests.`,
    );
  }
  const packRoot = path.resolve(dir);
  const packId = validation.manifest.id;
  const problemsRoot = path.join(packRoot, validation.manifest.problemsRoot);

  const cases: ProblemTestCase[] = [];
  for (const problemDir of discoverProblemDirs(problemsRoot)) {
    cases.push(...loadProblemCases(packRoot, problemDir));
  }

  // Preserve a stable, path-sorted order so the JSON summary is deterministic.
  return mergePackId(packId, runHarness(packId, cases));
}

/** Re-stamp every result with the manifest pack id (defensive: fixtures omit it). */
function mergePackId(packId: string, result: HarnessResult): HarnessResult {
  const results: ProblemTestResult[] = result.results.map((r) => ({ ...r, packId }));
  return { ...result, packId, results };
}

/** Discover problem directories (`<problemsRoot>/<category>/<id>/`) holding a metadata.json. */
function discoverProblemDirs(problemsRoot: string): string[] {
  const dirs: string[] = [];
  for (const category of readDirNames(problemsRoot)) {
    const categoryAbs = path.join(problemsRoot, category);
    for (const problem of readDirNames(categoryAbs)) {
      const problemAbs = path.join(categoryAbs, problem);
      if (fs.existsSync(path.join(problemAbs, METADATA_FILENAME))) dirs.push(problemAbs);
    }
  }
  return dirs.sort((a, b) => a.localeCompare(b));
}

function readDirNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Load one problem's fixtures. A scoring problem must declare a non-empty
 * `tests/` directory; a deploy-only problem may omit it (returns no cases).
 */
function loadProblemCases(packRoot: string, problemDir: string): ProblemTestCase[] {
  const metadata = readJson(path.join(problemDir, METADATA_FILENAME));
  const declaresScoring = isRecord(metadata) && metadata.scoring !== undefined;
  const testsDir = path.join(problemDir, TESTS_DIRNAME);
  const rel = path.relative(packRoot, problemDir);

  if (!fs.existsSync(testsDir)) {
    if (declaresScoring) {
      throw new HarnessError(
        `Problem '${rel}' declares scoring but ships no '${TESTS_DIRNAME}/' directory. Add at least one ${TESTS_DIRNAME}/*.json fixture.`,
      );
    }
    return [];
  }

  const cases = loadCasesFromDir(testsDir, rel);
  if (declaresScoring && cases.length === 0) {
    throw new HarnessError(
      `Problem '${rel}' declares scoring but its '${TESTS_DIRNAME}/' directory has no cases.`,
    );
  }
  return cases;
}

/** Read every `*.json` fixture file in a tests dir, in sorted filename order. */
function loadCasesFromDir(testsDir: string, problemRel: string): ProblemTestCase[] {
  const cases: ProblemTestCase[] = [];
  const files = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const parsed = readJson(path.join(testsDir, file));
    const fileRel = `${problemRel}/${TESTS_DIRNAME}/${file}`;
    for (const testCase of asCaseArray(parsed, fileRel)) {
      cases.push(assertCaseShape(testCase, fileRel));
    }
  }
  return cases;
}

function asCaseArray(parsed: unknown, fileRel: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.cases)) return parsed.cases;
  if (isRecord(parsed)) return [parsed];
  throw new HarnessError(`Fixture '${fileRel}' must be a test case object or an array of them.`);
}

/** Minimal shape guard: a fixture must at least name itself and its metadata/expected. */
function assertCaseShape(value: unknown, fileRel: string): ProblemTestCase {
  if (!isRecord(value)) {
    throw new HarnessError(`Fixture '${fileRel}' contains a non-object test case.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new HarnessError(`Fixture '${fileRel}' has a case with no 'name'.`);
  }
  if (!isRecord(value.metadata) || typeof value.metadata.id !== "string") {
    throw new HarnessError(`Fixture '${fileRel}' case '${value.name}' has no metadata.id.`);
  }
  if (!isRecord(value.expected)) {
    throw new HarnessError(`Fixture '${fileRel}' case '${value.name}' has no 'expected' block.`);
  }
  return value as unknown as ProblemTestCase;
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new HarnessError(`Could not read '${file}': ${(err as Error).message}.`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HarnessError(`'${file}' is not valid JSON: ${(err as Error).message}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
