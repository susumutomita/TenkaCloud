/**
 * [Problem Packs / Issue #2088, extended in #2089 and #2094] Thin CLI layer for
 * the offline pack tooling.
 *
 * `runPackCli(args, write)` is a pure function over the argv tail and a line
 * sink, so it is fully testable without spawning a process. It dispatches the
 * offline subcommands:
 *   - `validate <dir> [--json]` (#2088) → {@link validatePackDirectory}, rendered
 *     as machine-readable JSON (`--json`) or human text.
 *   - `init <dir> [--runtime <provider/engine>]` (#2089) → {@link writePackScaffold},
 *     scaffolding a fresh, validator-passing pack.
 *   - `install <dir> [--store <dir>]` (#2094) → {@link installPack}: validate →
 *     snapshot → lock → dry-run compose (proves no duplicate-id conflict; does
 *     NOT activate). Atomic — an invalid install leaves no residue.
 *   - `install git <https-url> --commit <full-sha> [--subdir <path>]` (#2097) →
 *     {@link installGitPack}: fetch a PINNED, immutable commit over HTTPS into a
 *     temp dir, then validate → snapshot → lock just like a local install. The
 *     transport is injectable so the CLI runs offline; the lock records the repo
 *     URL + commit + subdir + digest with `sourceKind: "git"`.
 *   - `list [--store <dir>] [--json]` (#2094) → {@link listInstalledPacks}: reads
 *     ONLY the local lock + snapshot metadata; never shows snapshot fs paths.
 *   - `inspect <id@version> [--store <dir>] [--json]` (#2094) →
 *     {@link inspectPack}: manifest, digest, problem ids, runtimes, dep status.
 *   - `remove <id@version> [--store <dir>] [--pins <file>]` (#2094) →
 *     {@link removePack}: refused while a pin record references the revision.
 *
 * There is deliberately NO `update` command: a new version is a separate install.
 * Every command is local + offline — no cloud / remote calls.
 *
 * Exit-code contract (shared by every subcommand):
 *   0 — success (valid pack / scaffolded / installed / listed / inspected / removed)
 *   1 — refusal (validation failure / digest or compose conflict / not installed
 *       / pinned removal)
 *   2 — tool failure (missing dir / missing manifest / bad usage / unsafe or
 *       non-empty init target / unsupported runtime / missing flag value)
 */

import * as fs from "node:fs";
import { z } from "zod";
import {
  buildPackScaffold,
  type PackInitRuntime,
  SCAFFOLD_RUNTIMES,
  writePackScaffold,
} from "./init-pack.js";
import {
  type InstalledPackSummary,
  inspectPack,
  listInstalledPacks,
  type PackInspection,
  type PinPredicate,
  removePack,
} from "./lifecycle.js";
import {
  INSTALL_USAGE,
  type LineWriter,
  type PackCliDeps,
  runInstall,
} from "./pack-cli-install.js";
import type { PackLockEntry } from "./snapshot.js";
import { type PackValidationResult, validatePackDirectory } from "./validate-pack.js";

export type { LineWriter, PackCliDeps } from "./pack-cli-install.js";

/** Diagnostic codes that mean "could not even start validating" → exit 2. */
const TOOL_FAILURE_CODES = new Set(["PACK_DIR_MISSING", "MANIFEST_MISSING", "MANIFEST_UNREADABLE"]);

const EXIT_OK = 0;
const EXIT_VALIDATION_FAILURE = 1;
const EXIT_TOOL_FAILURE = 2;

const VALIDATE_USAGE = "Usage: tenkacloud pack validate <dir> [--json]";
const INIT_USAGE = "Usage: tenkacloud pack init <dir> [--runtime <provider/engine>]";
const LIST_USAGE = "Usage: tenkacloud pack list [--store <dir>] [--json]";
const INSPECT_USAGE = "Usage: tenkacloud pack inspect <id@version> [--store <dir>] [--json]";
const REMOVE_USAGE = "Usage: tenkacloud pack remove <id@version> [--store <dir>] [--pins <file>]";
const USAGE = [
  VALIDATE_USAGE,
  INIT_USAGE,
  INSTALL_USAGE,
  LIST_USAGE,
  INSPECT_USAGE,
  REMOVE_USAGE,
].join("\n");

/** Default pack id used when `init` is run without an explicit id flag. */
const DEFAULT_INIT_PACK_ID = "com.example.starter";

/** Default snapshot store, relative to the CWD, for the lifecycle subcommands. */
const DEFAULT_STORE_DIR = ".tenkacloud/pack-store";

/**
 * The `--pins` file shape: a JSON array of `{ packId, version }` records that
 * model the event / deployment / activation references pinning a revision. Zod
 * validates the boundary so malformed input fails loudly rather than silently
 * treating every revision as unpinned.
 */
const PinRecordsSchema = z.array(
  z
    .object({
      packId: z.string().min(1),
      version: z.string().min(1),
    })
    .strict(),
);

/**
 * Run the `pack` CLI over an argv tail (everything after `pack`). Returns the
 * process exit code; all output goes through `write` so callers control the sink.
 * `deps` injects the Git transport so callers / tests stay offline.
 */
export function runPackCli(
  args: readonly string[],
  write: LineWriter,
  deps: PackCliDeps = {},
): number {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "validate":
      return runValidate(rest, write);
    case "init":
      return runInit(rest, write);
    case "install":
      return runInstall(rest, write, deps);
    case "list":
      return runList(rest, write);
    case "inspect":
      return runInspect(rest, write);
    case "remove":
      return runRemove(rest, write);
    default:
      // No `update` command exists in v1: a new version is a separate install.
      write(USAGE);
      return EXIT_TOOL_FAILURE;
  }
}

/**
 * Extract a single-value flag (`--name value`) from an argv tail. Returns the
 * value, the surviving args, and whether the flag was malformed (present with no
 * value — the next token is another flag or the flag was last). A malformed flag
 * is a hard error so the CLI never silently substitutes a default.
 */
function takeFlag(
  args: readonly string[],
  name: string,
): { value?: string; rest: string[]; malformed: boolean } {
  const index = args.indexOf(name);
  if (index < 0) return { rest: [...args], malformed: false };
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    return { rest: [...args], malformed: true };
  }
  const rest = args.filter((_, i) => i !== index && i !== index + 1);
  return { value: next, rest, malformed: false };
}

/** Split `id@version` into its parts. Returns undefined when `@version` is absent. */
function parsePackRef(ref: string | undefined): { id: string; version: string } | undefined {
  if (!ref) return undefined;
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1) return undefined;
  return { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

function runList(rest: readonly string[], write: LineWriter): number {
  const json = rest.includes("--json");
  const store = takeFlag(rest, "--store");
  if (store.malformed) {
    write(LIST_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const packs = listInstalledPacks(store.value ?? DEFAULT_STORE_DIR);
  if (json) {
    write(JSON.stringify(packs, null, 2));
  } else {
    renderList(packs, write);
  }
  return EXIT_OK;
}

function runInspect(rest: readonly string[], write: LineWriter): number {
  const json = rest.includes("--json");
  const store = takeFlag(rest, "--store");
  if (store.malformed) {
    write(INSPECT_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const positional = store.rest.filter((arg) => !arg.startsWith("--"));
  const ref = parsePackRef(positional[0]);
  if (!ref) {
    write(INSPECT_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const inspection = inspectPack(store.value ?? DEFAULT_STORE_DIR, ref.id, ref.version);
  if (!inspection) {
    write(`Pack '${ref.id}@${ref.version}' is not installed.`);
    return EXIT_VALIDATION_FAILURE;
  }
  if (json) {
    write(JSON.stringify(inspection, null, 2));
  } else {
    renderInspection(inspection, write);
  }
  return EXIT_OK;
}

function runRemove(rest: readonly string[], write: LineWriter): number {
  const store = takeFlag(rest, "--store");
  if (store.malformed) {
    write(REMOVE_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const pins = takeFlag(store.rest, "--pins");
  if (pins.malformed) {
    write(REMOVE_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const ref = parsePackRef(pins.rest.filter((arg) => !arg.startsWith("--"))[0]);
  if (!ref) {
    write(REMOVE_USAGE);
    return EXIT_TOOL_FAILURE;
  }

  let isPinned: PinPredicate;
  try {
    isPinned = pinPredicateFromFile(pins.value);
  } catch {
    // A missing or malformed --pins file is a tool failure, not a validation
    // failure — surface it as exit 2 instead of letting the throw escape.
    write(REMOVE_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const result = removePack(store.value ?? DEFAULT_STORE_DIR, ref.id, ref.version, isPinned);
  if (!result.ok) {
    write(result.message);
    return EXIT_VALIDATION_FAILURE;
  }
  write(`Removed ${result.removed.packId}@${result.removed.version}.`);
  return EXIT_OK;
}

/**
 * Build a pin predicate from an optional pins file. The file is a JSON array of
 * `{ packId, version }` records modelling event / deployment / activation
 * references; a revision listed there is pinned. With no file, nothing is pinned.
 */
function pinPredicateFromFile(pinsPath: string | undefined): PinPredicate {
  if (!pinsPath) return () => false;
  const pins = readPinRecords(pinsPath);
  return (entry: PackLockEntry) =>
    pins.some((pin) => pin.packId === entry.packId && pin.version === entry.version);
}

/** Parse the pins file into `{ packId, version }` records. Validated with Zod. */
function readPinRecords(pinsPath: string): readonly { packId: string; version: string }[] {
  const raw = fs.readFileSync(pinsPath, "utf-8");
  const parsed = PinRecordsSchema.parse(JSON.parse(raw));
  return parsed;
}

function renderList(packs: readonly InstalledPackSummary[], write: LineWriter): void {
  if (packs.length === 0) {
    write("No packs installed.");
    return;
  }
  write(`Installed packs: ${packs.length}`);
  for (const pack of packs) {
    write(
      `  - ${pack.packId}@${pack.version} (${pack.sourceKind}, ${pack.problemCount} problem${
        pack.problemCount === 1 ? "" : "s"
      }, ${pack.contentDigest})`,
    );
  }
}

function renderInspection(inspection: PackInspection, write: LineWriter): void {
  write(`${inspection.packId}@${inspection.version}`);
  write(`  source: ${inspection.sourceKind}`);
  write(`  digest: ${inspection.contentDigest}`);
  write(`  core: ${inspection.core}`);
  write(
    `  runtimes: ${inspection.requiredRuntimes.map((r) => `${r.provider}/${r.engine}`).join(", ")}`,
  );
  write(`  problems: ${inspection.problemIds.join(", ")}`);
  if (inspection.dependencies.length > 0) {
    write("  dependencies:");
    for (const dependency of inspection.dependencies) {
      write(
        `    - ${dependency.id} ${dependency.range} (${
          dependency.satisfied ? "satisfied" : "unmet"
        })`,
      );
    }
  }
}

function runValidate(rest: readonly string[], write: LineWriter): number {
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const dir = positional[0];
  if (!dir) {
    write(VALIDATE_USAGE);
    return EXIT_TOOL_FAILURE;
  }

  const result = validatePackDirectory(dir);
  if (json) {
    write(renderJson(result));
  } else {
    renderHuman(result, write);
  }
  return exitCode(result);
}

function runInit(rest: readonly string[], write: LineWriter): number {
  const flagIndex = rest.indexOf("--runtime");
  // A bare `--runtime` with no value (it is the last token, or the next token is
  // another flag) is malformed input: fail loudly instead of silently scaffolding
  // the default runtime, which would generate the wrong pack.
  if (flagIndex >= 0 && (flagIndex === rest.length - 1 || rest[flagIndex + 1]?.startsWith("--"))) {
    write(INIT_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const runtimeArg = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  // Drop the flag and its value by index so a positional dir equal to the
  // runtime string is not accidentally consumed.
  const consumed = new Set(flagIndex >= 0 ? [flagIndex, flagIndex + 1] : []);
  const positional = rest.filter((arg, index) => !arg.startsWith("--") && !consumed.has(index));
  const dir = positional[0];
  if (!dir) {
    write(INIT_USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const runtime = resolveInitRuntime(runtimeArg, write);
  if (runtime === undefined && runtimeArg !== undefined) {
    return EXIT_TOOL_FAILURE;
  }

  try {
    writePackScaffold(dir, { packId: DEFAULT_INIT_PACK_ID, runtime });
  } catch (err) {
    write((err as Error).message);
    return EXIT_TOOL_FAILURE;
  }
  const count = buildPackScaffold({ packId: DEFAULT_INIT_PACK_ID, runtime }).size;
  write(`Pack scaffolded at ${dir} (${count} files). Run 'pack validate ${dir}' to check it.`);
  return EXIT_OK;
}

/**
 * Map the raw `--runtime` argument onto a supported runtime. Returns undefined
 * (and writes the error) when the value is unsupported; returns undefined too
 * when the flag was absent, in which case the caller defaults the runtime.
 */
function resolveInitRuntime(
  runtimeArg: string | undefined,
  write: LineWriter,
): PackInitRuntime | undefined {
  if (runtimeArg === undefined) return undefined;
  if ((SCAFFOLD_RUNTIMES as readonly string[]).includes(runtimeArg)) {
    return runtimeArg as PackInitRuntime;
  }
  write(`Unsupported runtime '${runtimeArg}'. Supported: ${SCAFFOLD_RUNTIMES.join(", ")}.`);
  return undefined;
}

function exitCode(result: PackValidationResult): number {
  if (result.ok) return EXIT_OK;
  const hasToolFailure = result.diagnostics.some((d) => TOOL_FAILURE_CODES.has(d.code));
  return hasToolFailure ? EXIT_TOOL_FAILURE : EXIT_VALIDATION_FAILURE;
}

function renderJson(result: PackValidationResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      problemIds: result.problemIds,
      diagnostics: result.diagnostics,
    },
    null,
    2,
  );
}

function renderHuman(result: PackValidationResult, write: LineWriter): void {
  if (result.ok) {
    const count = result.problemIds.length;
    write(`Pack is valid: ${count} problem${count === 1 ? "" : "s"}.`);
    for (const id of result.problemIds) {
      write(`  - ${id}`);
    }
    return;
  }
  write(`Pack validation failed: ${result.diagnostics.length} diagnostic(s).`);
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.path ? `${diagnostic.file}:${diagnostic.path}` : diagnostic.file;
    write(`  [${diagnostic.code}] ${location}`);
    write(`      ${diagnostic.message}`);
  }
}
