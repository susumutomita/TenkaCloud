#!/usr/bin/env bun
import { runPackCli } from "./problem-pack/pack-cli";

const [command, ...args] = process.argv.slice(2);
if (command === "pack") {
  process.exitCode = runPackCli(args, (line) => console.log(line));
} else {
  console.log(
    "Usage: tenkacloud pack <command>\nHost a competition with: make local [LOCAL_ARGS=...]\nStop it with: make down [LOCAL_ARGS=...]\nLegacy Lite commands are retired; see docs/legacy-operations.md.",
  );
  process.exitCode = command === undefined || command === "--help" || command === "help" ? 0 : 1;
}
