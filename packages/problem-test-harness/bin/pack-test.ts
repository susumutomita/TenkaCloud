#!/usr/bin/env bun
/**
 * [Problem Test Harness / Issue #2107] `tenkacloud pack test <dir>` CLI.
 *
 * Runs a pack's local fixtures and prints both a human summary and the
 * machine-readable JSON result. Exit codes (issue §7):
 *   - 0 — every case passed
 *   - 1 — at least one case failed its assertion
 *   - 2 — a harness/tool error (a {@link HarnessError}: bad dir, malformed fixture)
 *
 * It is offline and deterministic: it never deploys, runs a Pack's shell, or
 * makes a real network probe.
 */

import { formatSummary } from "../src/format.js";
import { runPackTests } from "../src/pack-runner.js";
import { toJsonResult } from "../src/run-harness.js";
import {
  HARNESS_EXIT_OK,
  HARNESS_EXIT_TEST_FAILURE,
  HARNESS_EXIT_TOOL_ERROR,
  HarnessError,
} from "../src/types.js";

function main(argv: readonly string[]): number {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write("usage: tenkacloud-pack-test <pack-dir> [--json]\n");
    return HARNESS_EXIT_TOOL_ERROR;
  }
  const jsonOnly = argv.includes("--json");

  let result: ReturnType<typeof runPackTests>;
  try {
    result = runPackTests(dir);
  } catch (err) {
    if (err instanceof HarnessError) {
      process.stderr.write(`harness error: ${err.message}\n`);
      return HARNESS_EXIT_TOOL_ERROR;
    }
    throw err;
  }

  if (jsonOnly) {
    process.stdout.write(`${toJsonResult(result)}\n`);
  } else {
    process.stdout.write(`${formatSummary(result)}\n`);
    process.stdout.write(`${toJsonResult(result)}\n`);
  }
  return result.ok ? HARNESS_EXIT_OK : HARNESS_EXIT_TEST_FAILURE;
}

process.exit(main(process.argv.slice(2)));
