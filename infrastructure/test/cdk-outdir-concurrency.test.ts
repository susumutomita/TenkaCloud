import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INFRASTRUCTURE_ROOT = resolve(__dirname, "..");
const CHILD_TIMEOUT_MS = 30_000;

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // The process may have exited between the timeout and the kill attempt.
  }
}

function runFixtureTest(
  role: "fast" | "slow",
  barrierDir: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "bun",
      [
        "run",
        "test/run-vitest.ts",
        "run",
        "test/cdk-outdir-concurrency-fixture.test.ts",
        "--reporter=dot",
      ],
      {
        cwd: INFRASTRUCTURE_ROOT,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          TENKACLOUD_CDK_CONCURRENCY_BARRIER_DIR: barrierDir,
          TENKACLOUD_CDK_CONCURRENCY_ROLE: role,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectRun(new Error(`parallel Vitest wrapper timed out:\n${output}`));
        return;
      }
      resolveRun({ exitCode: code ?? 1, output });
    });
  });
}

describe("CDK test outdir concurrency", () => {
  it("should let two parallel wrapper invocations synthesize without deleting each other", async () => {
    const barrierDir = mkdtempSync(join(tmpdir(), "tenkacloud-cdk-concurrency-"));
    let results: Array<{ exitCode: number; output: string }>;
    try {
      results = await Promise.all([
        runFixtureTest("fast", barrierDir),
        runFixtureTest("slow", barrierDir),
      ]);
    } finally {
      rmSync(barrierDir, { force: true, recursive: true });
    }

    for (const result of results) {
      expect(result.exitCode, result.output).toBe(0);
    }
  });
});
