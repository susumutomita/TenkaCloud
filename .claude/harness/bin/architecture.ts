#!/usr/bin/env bun
import { formatFindings, HELP_TEXT, HelpRequested, parseArgs, run } from "../src/cli.ts";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = run(options);
  const output = formatFindings(result.findings);
  if (result.exitCode === 0) console.log(output.trimEnd());
  else console.error(output.trimEnd());
  process.exit(result.exitCode);
} catch (err) {
  if (err instanceof HelpRequested) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`architecture harness failed: ${message}`);
  process.exit(1);
}
