/**
 * [Problem SDK / Issue #2108] `pack-report` CLI — the single offline command the
 * reusable external Pack CI workflow runs.
 *
 * `runPackReportCli(args, env, write)` is a pure function over the argv tail, a
 * minimal environment view, and a line sink, so it is fully testable without
 * spawning a process or reading `process.env` directly. It:
 *   1. validates the pack directory and builds a deterministic {@link PackReport};
 *   2. writes the serialized report to `--out <path>` when given (the workflow's
 *      `validation-report-path`);
 *   3. emits the report's stable scalar fields (result / pack-id / pack-version /
 *      content-digest / report-path) to `GITHUB_OUTPUT` when that env var points
 *      at a writable file, so the reusable workflow can surface them as outputs;
 *   4. prints a human summary line through `write`.
 *
 * It NEVER executes a script from the pack, never touches the network, and never
 * reads cloud credentials — the only work is the SDK's read-only validation plus
 * writing the report / output files the workflow asked for.
 *
 * Exit-code contract:
 *   0 — the pack validated (`result: "passed"`).
 *   1 — the pack failed validation (`result: "failed"`).
 *   2 — bad CLI usage (missing pack directory argument or a malformed flag).
 */

import * as fs from "node:fs";
import { buildPackReport, type PackReport, serializePackReport } from "./report.js";

/** A sink for one line of human-readable CLI output. */
export type LineWriter = (line: string) => void;

/** The minimal environment view the CLI reads (kept explicit for testability). */
export interface ReportCliEnv {
  /** Path to the GitHub Actions step-output file; outputs are appended when set. */
  readonly GITHUB_OUTPUT?: string;
}

const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = "Usage: pack-report <pack-directory> [--out <report.json>] [--no-local-tests]";

/**
 * Run the `pack-report` CLI over an argv tail. Returns the process exit code; all
 * human output goes through `write`. `env` is injected so the CLI never reads
 * `process.env` itself, keeping it deterministic and testable.
 */
export function runPackReportCli(
  args: readonly string[],
  env: ReportCliEnv,
  write: LineWriter,
): number {
  const out = takeFlag(args, "--out");
  if (out.malformed) {
    write(USAGE);
    return EXIT_USAGE;
  }
  const runLocalTests = !out.rest.includes("--no-local-tests");
  const positional = out.rest.filter((arg) => !arg.startsWith("--"));
  const dir = positional[0];
  if (!dir) {
    write(USAGE);
    return EXIT_USAGE;
  }

  const report = buildPackReport(dir, { runLocalTests });

  let reportPath = "";
  if (out.value) {
    fs.writeFileSync(out.value, serializePackReport(report));
    reportPath = out.value;
  }

  writeGithubOutputs(env.GITHUB_OUTPUT, report, reportPath);
  renderSummary(report, reportPath, write);

  return report.result === "passed" ? EXIT_PASSED : EXIT_FAILED;
}

/**
 * Append the report's stable scalar fields to the GitHub Actions output file
 * (`GITHUB_OUTPUT`). No-op when the env var is absent, so the CLI runs the same
 * way locally. Each value is a single line (the fields are ids / SemVers / a hex
 * digest / a path — never multi-line), so the simple `key=value` form is safe.
 */
function writeGithubOutputs(
  githubOutput: string | undefined,
  report: PackReport,
  reportPath: string,
): void {
  if (!githubOutput) return;
  const lines = [
    `result=${report.result}`,
    `pack-id=${report.packId}`,
    `pack-version=${report.packVersion}`,
    `content-digest=${report.contentDigest}`,
    `validation-report-path=${reportPath}`,
  ];
  fs.appendFileSync(githubOutput, `${lines.join("\n")}\n`);
}

function renderSummary(report: PackReport, reportPath: string, write: LineWriter): void {
  const idLabel = report.packId ? `${report.packId}@${report.packVersion}` : "(manifest unparsed)";
  write(`Pack report: ${report.result} — ${idLabel} (${report.problemIds.length} problem(s)).`);
  write(`  content-digest: ${report.contentDigest}`);
  if (reportPath) write(`  report: ${reportPath}`);
  if (report.diagnostics.length > 0) {
    write(`  diagnostics: ${report.diagnostics.length}`);
    for (const diagnostic of report.diagnostics) {
      write(`    [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
}

/**
 * Extract a single-value flag (`--name value`). Returns the value, the surviving
 * args, and whether it was malformed (present with no value — the next token is
 * another flag or the flag was last). A malformed flag is a hard usage error so
 * the CLI never silently substitutes a default.
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
