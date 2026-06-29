#!/usr/bin/env node
/**
 * [Problem Packs / Issue #2088] `tenkacloud pack` CLI entry.
 *
 * A local, offline author tool — no CDK synth, no cloud credentials, no network.
 * It only reads a problem-pack directory and prints diagnostics. Wire it via the
 * `pack` package.json script: `bun bin/tenkacloud-pack.ts validate <dir> [--json]`.
 */

import { runPackCli } from "../lib/problem-pack/pack-cli.js";

const exitCode = runPackCli(process.argv.slice(2), (line) => {
  console.log(line);
});
process.exit(exitCode);
