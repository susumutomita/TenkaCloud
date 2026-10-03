#!/usr/bin/env bun
import { resolve } from "node:path";
import { systemProcessRunner } from "../cli/process";
import { loadTursoLiveEnvironment } from "../cli/turso-live-environment";
import { runTursoLivePreflight } from "./turso-live-guide";

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dirname, "../..");
    const env = loadTursoLiveEnvironment(
      root,
      process.env.ENV ?? process.env.CDK_PARAM_ENVIRONMENT ?? "development",
      process.env,
    ).env;
    if (env.REGION?.trim()) env.AWS_REGION = env.REGION.trim();
    if ((env.CDK_PARAM_CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb") !== "dynamodb") {
      const result = await runTursoLivePreflight(env, (command, args) =>
        systemProcessRunner.run(command, args, { cwd: root, env }),
      );
      console.log(result.output);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
