#!/usr/bin/env bun
import { runPackCli } from "./problem-pack/pack-cli";

const [command, ...args] = process.argv.slice(2);
if (command === "pack") {
  process.exitCode = runPackCli(args, (line) => console.log(line));
} else {
  console.log(
    "Usage: tenkacloud pack <command>\nHost a competition with: make local [LOCAL_ARGS=...]\nStop it with: make down [LOCAL_ARGS=...]\nCloud hosting: make deploy / make destroy [CLOUD_ARGS=...]",
  );
  process.exitCode = command === undefined || command === "--help" || command === "help" ? 0 : 1;
}
