import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * [Issue #2564] `make env-check-lite` must reject a misconfigured Turso/SQL
 * `.env` before `make deploy` runs the full SPA build — previously it checked
 * only that `.env` exists and an admin email is set, so a
 * `CDK_PARAM_CONTROL_DATA_BACKEND=turso` selection with a missing
 * `CDK_PARAM_TURSO_DATABASE_URL`/`CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME`
 * sailed through this gate and only failed much later (CDK synth, or worse, at
 * Lambda cold start).
 *
 * Drives the real `make env-check-lite` target (not a re-implementation of its
 * shell logic) against a disposable fixture environment directory, so this
 * pins the actual Makefile recipe's behavior.
 */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE_ENV = "test-turso-env-check-lite-fixture";
const FIXTURE_DIR = join(REPO_ROOT, "infrastructure", "environments", FIXTURE_ENV);
const FIXTURE_ENV_FILE = join(FIXTURE_DIR, ".env");

function runEnvCheckLite(envFileContent: string): { status: number | null; output: string } {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_ENV_FILE, envFileContent, "utf8");
  const result = spawnSync("make", ["env-check-lite", `ENV=${FIXTURE_ENV}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("make env-check-lite Turso/SQL validation (#2564)", () => {
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("should fail before deploy when turso is selected but both Turso vars are missing", () => {
    const { status, output } = runEnvCheckLite(
      "TENANT_ADMIN_EMAIL=test@example.com\nCDK_PARAM_CONTROL_DATA_BACKEND=turso\n",
    );
    expect(status).not.toBe(0);
    expect(output).toContain("CDK_PARAM_TURSO_DATABASE_URL");
    expect(output).toContain("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME");
  });

  it("should fail and name only the missing var when just the token parameter name is absent", () => {
    const { status, output } = runEnvCheckLite(
      [
        "TENANT_ADMIN_EMAIL=test@example.com",
        "CDK_PARAM_CONTROL_DATA_BACKEND=sql",
        "CDK_PARAM_TURSO_DATABASE_URL=libsql://example.turso.io",
        "",
      ].join("\n"),
    );
    expect(status).not.toBe(0);
    expect(output).toContain("CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME");
    expect(output).not.toContain("CDK_PARAM_TURSO_DATABASE_URL は");
  });

  it.each([
    "turso",
    "sql",
    "turso-mirror",
    "sql-mirror",
  ])("should pass for backend=%s when both Turso vars are present", (backend) => {
    const { status } = runEnvCheckLite(
      [
        "TENANT_ADMIN_EMAIL=test@example.com",
        `CDK_PARAM_CONTROL_DATA_BACKEND=${backend}`,
        "CDK_PARAM_TURSO_DATABASE_URL=libsql://example.turso.io",
        "CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/tenkacloud/development/turso-token",
        "",
      ].join("\n"),
    );
    expect(status).toBe(0);
  });

  it("should pass without requiring Turso vars when the backend is unset (default dynamodb)", () => {
    const { status } = runEnvCheckLite("TENANT_ADMIN_EMAIL=test@example.com\n");
    expect(status).toBe(0);
  });

  it("should pass without requiring Turso vars when the backend is explicitly dynamodb", () => {
    const { status } = runEnvCheckLite(
      "TENANT_ADMIN_EMAIL=test@example.com\nCDK_PARAM_CONTROL_DATA_BACKEND=dynamodb\n",
    );
    expect(status).toBe(0);
  });
});
