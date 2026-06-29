/**
 * [Problem Packs / Issue #2088] Thin CLI layer for the offline pack validator.
 *
 * `runPackCli(args, write)` is a pure function over the argv tail and a line
 * sink, so it is fully testable without spawning a process. It dispatches the
 * `validate <dir>` subcommand to {@link validatePackDirectory} and renders the
 * result either as machine-readable JSON (`--json`) or human text.
 *
 * Exit-code contract:
 *   0 — valid pack
 *   1 — validation failure (the pack was readable but has diagnostics)
 *   2 — tool failure (missing dir / missing manifest / bad usage)
 */

import { type PackValidationResult, validatePackDirectory } from "./validate-pack.js";

/** Diagnostic codes that mean "could not even start validating" → exit 2. */
const TOOL_FAILURE_CODES = new Set(["PACK_DIR_MISSING", "MANIFEST_MISSING", "MANIFEST_UNREADABLE"]);

const EXIT_OK = 0;
const EXIT_VALIDATION_FAILURE = 1;
const EXIT_TOOL_FAILURE = 2;

const USAGE = "Usage: tenkacloud pack validate <dir> [--json]";

/** Sink for a single line of output (no trailing newline). */
export type LineWriter = (line: string) => void;

/**
 * Run the `pack` CLI over an argv tail (everything after `pack`). Returns the
 * process exit code; all output goes through `write` so callers control the sink.
 */
export function runPackCli(args: readonly string[], write: LineWriter): number {
  const [subcommand, ...rest] = args;
  if (subcommand !== "validate") {
    write(USAGE);
    return EXIT_TOOL_FAILURE;
  }
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const dir = positional[0];
  if (!dir) {
    write(USAGE);
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
