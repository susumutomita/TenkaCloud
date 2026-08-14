#!/usr/bin/env bun

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLocalCommandDeps, runLocalCommand } from "./cli/local-command";
import { systemProcessRunner } from "./cli/process";
import { installTursoCli } from "./cli/turso-cli-installer";
import { runTursoLiveCommand, terminalConfirm, terminalPrompt } from "./cli/turso-live-command";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function tenkaCloudUsage(): string {
  return [
    "Usage: tenkacloud <command>",
    "",
    "Commands:",
    "  tenkacloud local [subcommand] [--database sqlite|turso] [--problem ID]",
    "        Start local play; SQLite is the default and requires no cloud account",
    "  tenkacloud doctor [--profile minimum|recommended|full] [--probe-disk]",
    "        Diagnose host Bun/Vite developer prerequisites without changing the machine;",
    "        --profile also compares Docker's resources against that profile's",
    "        measured configuration (--probe-disk adds free space, pulls busybox)",
    "  tenkacloud onboard [--yes]",
    "        Interactively repair missing local prerequisites",
    "  tenkacloud turso-live [guide|preflight|deploy|verify-cloudformation|reset]",
    "        Guided Turso/AWS live verification",
  ].join("\n");
}

export async function runTenkaCloudCli(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "local") {
    return runLocalCommand(rest, defaultLocalCommandDeps(REPO_ROOT, systemProcessRunner));
  }
  if (command === "doctor" || command === "onboard") {
    return systemProcessRunner.run(
      process.execPath,
      [
        "run",
        resolve(REPO_ROOT, "scripts", "tenkacloud-onboard.ts"),
        command === "doctor" ? "doctor" : "preflight",
        ...rest,
      ],
      { inherit: true, cwd: REPO_ROOT },
    ).status;
  }
  if (command === "turso-live") {
    return runTursoLiveCommand(rest, process.env, {
      repoRoot: REPO_ROOT,
      processRunner: systemProcessRunner,
      interactive: Boolean(process.stdin.isTTY) && !process.env.CI,
      platform: process.platform,
      architecture: process.arch,
      homeDirectory: homedir(),
      installTursoCli: () =>
        installTursoCli({
          architecture: process.arch,
          homeDirectory: homedir(),
          platform: process.platform,
          processRunner: systemProcessRunner,
        }),
      confirm: terminalConfirm,
      prompt: terminalPrompt,
      log: console.log,
    });
  }
  console.log(tenkaCloudUsage());
  return command === undefined || command === "help" || command === "--help" ? 0 : 1;
}

if (import.meta.main) {
  void runTenkaCloudCli(process.argv.slice(2))
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
