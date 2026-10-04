import { type StdioOptions, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  createDestroyAssembly,
  type DestroyAssembly,
  type DestroyAssemblyTarget,
} from "./destroy-assembly";
import { clearSelectedTursoData } from "./turso-clear";
import type { TursoTokenProbe } from "./turso-preflight";
import { purgeTursoControlData, type TursoResetTarget } from "./turso-reset";
import { resetSelectedTursoData } from "./turso-reset-command";
import { probeTursoConnection } from "./turso-schema";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly inherit?: boolean;
  /** Stream build output while retaining the receipt returned by source preparation. */
  readonly captureOutput?: boolean;
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
  probeTurso?: TursoTokenProbe;
  purgeTursoControlData?(target: TursoResetTarget): Promise<void>;
  resetSelectedTursoData?: typeof resetSelectedTursoData;
  clearSelectedTursoData?: typeof clearSelectedTursoData;
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
    purgeTursoControlData,
    resetSelectedTursoData,
    clearSelectedTursoData,
    probeTurso: (url, authToken) => probeTursoConnection({ url, authToken }),
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: (request) =>
      new Promise((resolve) => {
        let stdio: StdioOptions = "pipe";
        if (request.inherit)
          stdio = request.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit";
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          stdio,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (request.inherit) process.stdout.write(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (request.inherit) process.stderr.write(chunk);
        });
        child.once("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
        child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
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
