import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import {
  attachTenantFederatedAdminAllowlist,
  parseTenantAdminAllowlist,
} from "../../lib/tenant-template/saml-admin-allowlist";

/**
 * Issue #1340 Phase 2: per-tenant federated TenantAdmin allowlist wrapper の動作と
 * tenant 既定 envVarName (`TENANT_SAML_ADMIN_ALLOWLIST`) を pinning する。
 */
describe("parseTenantAdminAllowlist (#1340)", () => {
  it("should return empty array for undefined / empty input (= fail-safe = deny all federated)", () => {
    expect(parseTenantAdminAllowlist(undefined)).toEqual([]);
    expect(parseTenantAdminAllowlist("")).toEqual([]);
  });

  it("should parse comma-separated entries", () => {
    const out = parseTenantAdminAllowlist("corp-entra/admin@example.com,corp-okta/dev@example.com");
    expect(out).toEqual(["corp-entra/admin@example.com", "corp-okta/dev@example.com"]);
  });

  it("should surface the tenant env var name in error messages", () => {
    expect(() => parseTenantAdminAllowlist("bad")).toThrow(/TENANT_SAML_ADMIN_ALLOWLIST/);
  });

  it("should reject malformed provider/email", () => {
    expect(() => parseTenantAdminAllowlist("no-slash")).toThrow(/must be 'provider\/email'/);
  });
});

describe("attachTenantFederatedAdminAllowlist (CDK) (#1340)", () => {
  it("should attach a Pre sign-up Lambda trigger on the per-tenant UserPool with allowlist env", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    attachTenantFederatedAdminAllowlist(stack, userPool, ["corp-entra/admin@example.com"]);
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          ADMIN_ALLOWLIST: "corp-entra/admin@example.com",
        },
      },
    });
    tpl.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: { PreSignUp: {} },
    });
  });

  it("should still attach the trigger when allowlist is empty (= fail-safe deny-all)", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    attachTenantFederatedAdminAllowlist(stack, userPool, []);
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Lambda::Function", 1);
  });
});
