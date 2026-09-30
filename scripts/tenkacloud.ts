#!/usr/bin/env bun
import { runPackCli } from "./problem-pack/pack-cli";

const [command, ...args] = process.argv.slice(2);
if (command === "pack") {
  process.exitCode = runPackCli(args, (line) => console.log(line));
} else {
  console.log(
    "Usage: tenkacloud pack <command>\nHost a competition with: bun start [host options]\nLegacy local/Lite commands are retired; see docs/legacy-operations.md.",
  );
  process.exitCode = command === undefined || command === "--help" || command === "help" ? 0 : 1;
}
