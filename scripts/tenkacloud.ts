#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { systemProcessRunner } from "./cli/process";
import { installTursoCli } from "./cli/turso-cli-installer";
import { runTursoLiveCommand, terminalConfirm, terminalPrompt } from "./cli/turso-live-command";
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
} else if (command === "turso-live") {
  try {
    process.exitCode = await runTursoLiveCommand(args, process.env, {
      repoRoot: resolve(import.meta.dirname, ".."),
      processRunner: systemProcessRunner,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI),
      platform: process.platform,
      architecture: process.arch,
      homeDirectory: homedir(),
      installTursoCli: () =>
        installTursoCli({
          platform: process.platform,
          architecture: process.arch,
          homeDirectory: homedir(),
          processRunner: systemProcessRunner,
        }),
      confirm: terminalConfirm,
      prompt: terminalPrompt,
      log: console.log,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.log(
    'Usage: tenkacloud pack <command>\nHost a competition with: make local [LOCAL_ARGS=...]\nStop it with: make down [LOCAL_ARGS=...]\nCloud hosting: make deploy / make destroy [CLOUD_ARGS=...]\nCloud setup: make env-init / make turso-live\nTurso credentials: make turso-token-rotate [ROTATE_ARGS=...]\nTurso competition data only: make turso-clear [CLOUD_ARGS="--plan|--yes"] (nonblank process-only TURSO_AUTH_TOKEN, otherwise configured SSM; --credentials <direct|ssm> overrides)\nAll control data, including account/IdP settings: make turso-reset [CLOUD_ARGS=...] or tenkacloud turso-live reset [--plan|--yes]',
  );
  process.exitCode = command === undefined || command === "--help" || command === "help" ? 0 : 1;
}
