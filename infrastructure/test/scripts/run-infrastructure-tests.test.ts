import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanCdkTestOutdir } from "../run-vitest";

const PACKAGE_JSON_PATH = resolve(__dirname, "..", "..", "package.json");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("infrastructure test runner (#1551)", () => {
  it("should remove stale CDK test synth output", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-cdk-out-"));
    tempDirs.push(root);
    const staleFile = join(root, "worker-123", "asset.zip");
    mkdirSync(join(root, "worker-123"), { recursive: true });
    writeFileSync(staleFile, "stale");

    cleanCdkTestOutdir(root);

    expect(existsSync(root)).toBe(false);
  });

  it("should route normal and coverage test runs through the cleanup wrapper", () => {
    const scripts = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).scripts as Record<
      string,
      string
    >;

    expect(scripts.test).toBe("bun run test/run-vitest.ts run");
    expect(scripts["test:coverage"]).toContain("bun run test/run-vitest.ts run --coverage");
  });
});
