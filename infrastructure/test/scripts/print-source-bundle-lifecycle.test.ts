import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "print-source-bundle-lifecycle.ts",
);

/**
 * Run the emit script with a deterministic env. SYSTEM_ADMIN_EMAIL and the
 * sourceBundle overrides are stripped first so the result does not depend on the
 * developer's shell — `overrides` then sets exactly what each test needs.
 */
function runLifecycle(overrides: Record<string, string> = {}): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SYSTEM_ADMIN_EMAIL;
  delete env.SOURCE_BUNDLE_KEEP_VERSIONS;
  delete env.SOURCE_BUNDLE_EXPIRE_DAYS;
  const bun = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "bun"))
    .find(existsSync);
  if (!bun) throw new Error("Bun is required to test source-bundle lifecycle emission");
  return spawnSync(bun, ["--no-env-file", "run", SCRIPT, "development"], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });
}

describe("scripts/ops/print-source-bundle-lifecycle.ts", () => {
  it("should emit a default policy without unrelated environment values", () => {
    // Reproduces the CodeBuild Lite-deploy failure: the buildspec injects
    // TENANT_ADMIN_EMAIL but not SYSTEM_ADMIN_EMAIL. The lifecycle policy must not
    // depend on that SaaS-only value (issue #2197 removed the old
    // controlPlaneConfig.systemAdminEmail config.json field it once came from).
    const result = runLifecycle();

    expect(result.status, result.stderr).toBe(0);
    const policy = JSON.parse(result.stdout);
    expect(policy.Rules[0].NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(5);
    expect(policy.Rules[0].NoncurrentVersionExpiration.NoncurrentDays).toBe(1);
    expect(result.stderr).not.toContain("SYSTEM_ADMIN_EMAIL");
  });

  it("should honor sourceBundleConfig env overrides", () => {
    const result = runLifecycle({
      SOURCE_BUNDLE_KEEP_VERSIONS: "9",
      SOURCE_BUNDLE_EXPIRE_DAYS: "4",
    });

    expect(result.status, result.stderr).toBe(0);
    const policy = JSON.parse(result.stdout);
    expect(policy.Rules[0].NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(9);
    expect(policy.Rules[0].NoncurrentVersionExpiration.NoncurrentDays).toBe(4);
  });
});
