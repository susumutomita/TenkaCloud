/**
 * [Problem Packs / Issue #2088, extended in #2089] Thin CLI layer for the
 * offline pack tooling.
 *
 * `runPackCli(args, write)` is a pure function over the argv tail and a line
 * sink, so it is fully testable without spawning a process. It dispatches two
 * subcommands:
 *   - `validate <dir> [--json]` (#2088) → {@link validatePackDirectory}, rendered
 *     as machine-readable JSON (`--json`) or human text.
 *   - `init <dir> [--runtime <provider/engine>]` (#2089) → {@link writePackScaffold},
 *     scaffolding a fresh, validator-passing pack.
 *
 * Exit-code contract (shared by both subcommands):
 *   0 — success (valid pack / pack scaffolded)
 *   1 — validation failure (the pack was readable but has diagnostics)
 *   2 — tool failure (missing dir / missing manifest / bad usage / unsafe or
 *       non-empty init target / unsupported runtime)
 */

import {
  buildPackScaffold,
  type PackInitRuntime,
  SCAFFOLD_RUNTIMES,
  writePackScaffold,
} from "./init-pack.js";
import { type PackValidationResult, validatePackDirectory } from "./validate-pack.js";

/** Diagnostic codes that mean "could not even start validating" → exit 2. */
const TOOL_FAILURE_CODES = new Set(["PACK_DIR_MISSING", "MANIFEST_MISSING", "MANIFEST_UNREADABLE"]);

const EXIT_OK = 0;
const EXIT_VALIDATION_FAILURE = 1;
const EXIT_TOOL_FAILURE = 2;

const VALIDATE_USAGE = "Usage: tenkacloud pack validate <dir> [--json]";
const INIT_USAGE = "Usage: tenkacloud pack init <dir> [--runtime <provider/engine>]";
const USAGE = `${VALIDATE_USAGE}\n${INIT_USAGE}`;

/** Default pack id used when `init` is run without an explicit id flag. */
const DEFAULT_INIT_PACK_ID = "com.example.starter";

/** Sink for a single line of output (no trailing newline). */
export type LineWriter = (line: string) => void;

/**
 * Run the `pack` CLI over an argv tail (everything after `pack`). Returns the
 * process exit code; all output goes through `write` so callers control the sink.
 */
export function runPackCli(args: readonly string[], write: LineWriter): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") {
    return runValidate(rest, write);
  }
  if (subcommand === "init") {
    return runInit(rest, write);
  }
  write(USAGE);
  return EXIT_TOOL_FAILURE;
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
