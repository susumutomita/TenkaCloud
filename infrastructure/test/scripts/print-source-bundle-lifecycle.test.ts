import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "print-source-bundle-lifecycle.ts");

/**
 * Run the emit script with a deterministic env. SYSTEM_ADMIN_EMAIL and the
 * sourceBundle overrides are stripped first so the result does not depend on the
 * developer's shell — `overrides` then sets exactly what each test needs.
 */
function runLifecycle(overrides: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SYSTEM_ADMIN_EMAIL;
  delete env.SOURCE_BUNDLE_KEEP_VERSIONS;
  delete env.SOURCE_BUNDLE_EXPIRE_DAYS;
  return spawnSync("bun", ["run", SCRIPT, "development"], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });
}

describe("scripts/print-source-bundle-lifecycle.ts", () => {
  it("should emit a policy in Lite mode without SYSTEM_ADMIN_EMAIL set", () => {
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
