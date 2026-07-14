import { spawnSync } from "node:child_process";

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  readonly run: (
    command: string,
    args: readonly string[],
    options?: {
      readonly inherit?: boolean;
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
    },
  ) => ProcessResult;
}

export const systemProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : "pipe",
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  },
};
