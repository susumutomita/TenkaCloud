import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";

/**
 * [Issue #2442 / Phase C2] `buildCompetitorAccountsSharedResources` cold-start test —
 * the real (unmocked) builder, mirroring `shared-builders.test.ts`'s
 * `buildEventSharedResources` coverage. Every other test touching this handler mocks
 * the builder outright, so the real env-reading branches were previously untested.
 *
 * `COMPETITOR_ACCOUNTS_TABLE_NAME` moved from a `getEnv`-required field to an
 * optional (`?? ""`) one: pure SQL backend (turso|sql) selection means
 * `ProblemDeployBackendStack` does not synth the table at all, and cold start must
 * not fail-fast (Initialization Error) for the whole Lambda just because this one
 * table is absent — the repository seam falls through to the SQL executor instead.
 */

const REQUIRED_ENV = {
  DEPLOY_ENVIRONMENT: "development",
  TENKACLOUD_ACCOUNT_ID: "111111111111",
};

beforeEach(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  process.env.COMPETITOR_ACCOUNTS_TABLE_NAME = "CompetitorAccounts";
});
afterEach(() => {
  for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
  delete process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
});

describe("buildCompetitorAccountsSharedResources", () => {
  it("should read every required env and construct the SDK clients", () => {
    const shared = buildCompetitorAccountsSharedResources();
    expect(shared.tableName).toBe("CompetitorAccounts");
    expect(shared.env).toBe("development");
    expect(shared.tenkaCloudAccountId).toBe("111111111111");
    expect(shared.ddb).toBeDefined();
    expect(shared.ssm).toBeDefined();
    expect(shared.sts).toBeDefined();
    expect(shared.cognito).toBeDefined();
  });

  it("should default tableName to '' when COMPETITOR_ACCOUNTS_TABLE_NAME is unset (pure SQL backend cold start)", () => {
    delete process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
    expect(() => buildCompetitorAccountsSharedResources()).not.toThrow();
    expect(buildCompetitorAccountsSharedResources().tableName).toBe("");
  });

  it("should throw when DEPLOY_ENVIRONMENT (a still-required env) is missing", () => {
    delete process.env.DEPLOY_ENVIRONMENT;
    expect(() => buildCompetitorAccountsSharedResources()).toThrow();
  });

  it("should throw when TENKACLOUD_ACCOUNT_ID (a still-required env) is missing", () => {
    delete process.env.TENKACLOUD_ACCOUNT_ID;
    expect(() => buildCompetitorAccountsSharedResources()).toThrow();
  });
});
