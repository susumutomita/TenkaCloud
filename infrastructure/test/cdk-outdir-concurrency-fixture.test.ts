import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

const BARRIER_TIMEOUT_MS = 10_000;
const SLOW_SYNTH_DELAY_MS = 500;

async function waitForBothWorkers(barrierDir: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (
    !existsSync(join(barrierDir, "ready-fast")) ||
    !existsSync(join(barrierDir, "ready-slow"))
  ) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for the CDK concurrency barrier");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

describe("CDK test outdir concurrency fixture", () => {
  it("should synthesize after both wrapper processes have created their Apps", async () => {
    const app = new App({ autoSynth: false });
    new Stack(app, "ConcurrencyFixtureStack");
    const barrierDir = process.env.TENKACLOUD_CDK_CONCURRENCY_BARRIER_DIR;
    const role = process.env.TENKACLOUD_CDK_CONCURRENCY_ROLE;

    if (barrierDir) {
      if (role !== "fast" && role !== "slow") throw new Error(`invalid concurrency role: ${role}`);
      writeFileSync(join(barrierDir, `ready-${role}`), "");
      await waitForBothWorkers(barrierDir);
      if (role === "slow") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, SLOW_SYNTH_DELAY_MS));
      }
    }

    expect(() => app.synth()).not.toThrow();
  });
});
