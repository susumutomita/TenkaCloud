import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { probeTursoConnection } from "../../infrastructure/lib/problem-deploy/control-data/sql-executor-cache";
import {
  createDestroyAssembly,
  type DestroyAssembly,
  type DestroyAssemblyTarget,
} from "./destroy-assembly";
import {
  type CloudInstallation,
  type InstallationLocation,
  openCloudInstallation,
} from "./installation";
import type { TursoTokenProbe } from "./turso-preflight";
import { purgeTursoControlData } from "./turso-reset";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly inherit?: boolean;
}
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface CloudCliIo {
  configureEnvironment?(env: NodeJS.ProcessEnv): void;
  run(request: ProcessRequest): Promise<ProcessResult>;
  createDestroyAssembly(target: DestroyAssemblyTarget): DestroyAssembly;
  stdout(text: string): void;
  stderr(text: string): void;
  confirm(question: string): Promise<boolean>;
  openInstallation(location: InstallationLocation): CloudInstallation | Promise<CloudInstallation>;
  probeTurso?: TursoTokenProbe;
  purgeTursoControlData?(target: {
    readonly databaseUrl: string;
    readonly parameterName: string;
    readonly region: string;
  }): Promise<void>;
  now(): number;
  wait(ms: number): Promise<void>;
}

/** Subprocesses use argument arrays; only CDK's documented --app value is a command string. */
export function systemCloudIo(): CloudCliIo {
  return {
    // Match the historical Makefile export: in-process SDK credential providers
    // must see the same selected profile/configuration as AWS/CDK subprocesses.
    // This CLI runs one command per process; it never writes an operator's files.
    configureEnvironment: (env) => Object.assign(process.env, env),
    createDestroyAssembly,
    openInstallation: openCloudInstallation,
    purgeTursoControlData,
    probeTurso: (url, authToken) => probeTursoConnection({ url, authToken }),
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: (request) =>
      new Promise((resolve) => {
        const process = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          stdio: request.inherit ? "inherit" : "pipe",
        });
        let stdout = "";
        let stderr = "";
        process.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        process.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        process.once("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
        process.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    confirm: async (question) => {
      if (!process.stdin.isTTY || process.env.CI) return false;
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes)$/iu.test((await reader.question(question)).trim());
      } finally {
        reader.close();
      }
    },
  };
}
