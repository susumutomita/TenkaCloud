#!/usr/bin/env node
/**
 * [Problem SDK / Issue #2108] `pack-report` CLI entry — the offline command the
 * reusable external Pack CI workflow runs.
 *
 * A local, offline tool: no CDK synth, no cloud credentials, no network, and no
 * execution of any script from the pack. It validates a problem-pack directory,
 * writes a deterministic JSON report, and emits GitHub Actions outputs. Invoke it
 * via the package bin: `bun bin/pack-report.ts <dir> [--out <report.json>]`.
 */

import { runPackReportCli } from "../src/report-cli.js";

const exitCode = runPackReportCli(
  process.argv.slice(2),
  { GITHUB_OUTPUT: process.env.GITHUB_OUTPUT },
  (line) => {
    console.log(line);
  },
);
process.exit(exitCode);
