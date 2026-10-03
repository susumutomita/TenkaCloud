#!/usr/bin/env bun
import { resolve } from "node:path";
import { runCloudCli } from "./cloud-hosting/cli";
import { systemCloudIo } from "./cloud-hosting/process";
import { runPackCli } from "./problem-pack/pack-cli";

const [command, ...args] = process.argv.slice(2);
if (command === "pack") {
  process.exitCode = runPackCli(args, (line) => console.log(line));
} else if (command === "turso-live" && args[0] === "reset") {
  process.exitCode = await runCloudCli(["turso-reset", ...args.slice(1)], systemCloudIo(), {
    root: resolve(import.meta.dirname, ".."),
    env: process.env,
  });
} else {
  console.log(
    "Usage: tenkacloud pack <command>\nHost a competition with: make local [LOCAL_ARGS=...]\nStop it with: make down [LOCAL_ARGS=...]\nCloud hosting: make deploy / make destroy [CLOUD_ARGS=...]\nTurso data reset: make turso-reset [CLOUD_ARGS=...] or tenkacloud turso-live reset [--plan|--yes]",
  );
  process.exitCode = command === undefined || command === "--help" || command === "help" ? 0 : 1;
}
