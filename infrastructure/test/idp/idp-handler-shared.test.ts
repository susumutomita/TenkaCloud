import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIdpSharedResources } from "../../lib/tenant-template/handlers/idp-handler/shared";

/**
 * [Issue #2442 / Phase C5] `buildIdpSharedResources` cold-start test — the real
 * (unmocked) builder, mirroring `competitor-accounts-shared.test.ts`'s coverage
 * of `buildCompetitorAccountsSharedResources`.
 *
 * `SAML_IDPS_TABLE_NAME` moved from a `requireEnv`-required field to an optional
 * (`?? ""`) one: pure SQL backend (turso|sql) selection means `TenkaCloudLiteStack`
 * does not synth `SamlIdpsTable` at all, and cold start must not fail-fast
 * (Initialization Error) for the whole Lambda just because this one table is
 * absent — the repository seam (`createSeamIdpStore`) falls through to the SQL
 * executor instead.
 */

const REQUIRED_ENV = {
  TENANT_USER_POOL_ID: "us-east-1_TEST",
};

beforeEach(() => {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  process.env.SAML_IDPS_TABLE_NAME = "SamlIdps";
});
afterEach(() => {
  for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
  delete process.env.SAML_IDPS_TABLE_NAME;
});

describe("buildIdpSharedResources", () => {
  it("should read every required env and construct the SDK clients", () => {
    const shared = buildIdpSharedResources();
    expect(shared.tableName).toBe("SamlIdps");
    expect(shared.userPoolId).toBe("us-east-1_TEST");
    expect(shared.ddb).toBeDefined();
    expect(shared.cognito).toBeDefined();
  });

  it("should default tableName to '' when SAML_IDPS_TABLE_NAME is unset (pure SQL backend cold start)", () => {
    delete process.env.SAML_IDPS_TABLE_NAME;
    expect(() => buildIdpSharedResources()).not.toThrow();
    expect(buildIdpSharedResources().tableName).toBe("");
  });

  it("should throw when TENANT_USER_POOL_ID (a still-required env) is missing", () => {
    delete process.env.TENANT_USER_POOL_ID;
    expect(() => buildIdpSharedResources()).toThrow();
  });
});
