#!/usr/bin/env bun
import { resolve } from "node:path";
import { runCloudCli } from "./cli";
import { systemCloudIo } from "./process";

if (import.meta.main) {
  process.exitCode = await runCloudCli(process.argv.slice(2), systemCloudIo(), {
    root: resolve(import.meta.dirname, "../.."),
    env: process.env,
  });
}
