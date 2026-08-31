import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { type CfnUserPoolClient, UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import {
  attachTenantSamlIdentityProviders,
  parseTenantSamlIdpConfig,
} from "../../lib/tenant-template/saml-identity-providers";

/**
 * Issue #1340 Phase 2: per-tenant SAML IdP env parsing + CDK attach。 Phase 1 の汎用 helper を
 * tenant-template namespace から呼び出す wrapper の動作と env 変数名 (`TENANT_SAML_IDPS`) を
 * pinning する。
 */
describe("parseTenantSamlIdpConfig (#1340)", () => {
  it("should return empty array for undefined / empty input", () => {
    expect(parseTenantSamlIdpConfig(undefined)).toEqual([]);
    expect(parseTenantSamlIdpConfig("")).toEqual([]);
  });

  it("should parse a valid single-IdP JSON array", () => {
    const raw = JSON.stringify([
      {
        name: "corp-entra",
        metadataUrl: "https://example/meta.xml",
        emailDomains: ["example.com"],
      },
    ]);
    const out = parseTenantSamlIdpConfig(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("corp-entra");
  });

  it("should fail-loud on invalid JSON with the tenant env var name in the message", () => {
    expect(() => parseTenantSamlIdpConfig("not-json")).toThrow(/TENANT_SAML_IDPS/);
  });

  it("should reject metadataUrl that is not https", () => {
    const raw = JSON.stringify([
      { name: "corp-entra", metadataUrl: "http://insecure/meta", emailDomains: ["example.com"] },
    ]);
    expect(() => parseTenantSamlIdpConfig(raw)).toThrow(/metadataUrl must be an https URL/);
  });
});

describe("attachTenantSamlIdentityProviders (CDK) (#1340)", () => {
  function makeStack() {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    const client = new UserPoolClient(stack, "Client", { userPool });
    const cfnClient = client.node.defaultChild as CfnUserPoolClient;
    return { stack, userPool, cfnClient };
  }

  it("should return an empty directory and create no SAML provider when configs is empty", () => {
    const { stack, userPool, cfnClient } = makeStack();
    const directory = attachTenantSamlIdentityProviders(stack, userPool, cfnClient, []);
    expect(directory).toEqual({});
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  it("should attach 1 IdP to the per-tenant UserPool and produce a domain → [provider] directory", () => {
    const { stack, userPool, cfnClient } = makeStack();
    const directory = attachTenantSamlIdentityProviders(stack, userPool, cfnClient, [
      { name: "tenant-entra", metadataUrl: "https://meta", emailDomains: ["acme.example"] },
    ]);
    expect(directory).toEqual({ "acme.example": ["tenant-entra"] });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    tpl.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "tenant-entra",
      ProviderType: "SAML",
    });
  });

  it("should keep COGNITO in SupportedIdentityProviders so local auth is preserved (= MFA fallback)", () => {
    const { stack, userPool, cfnClient } = makeStack();
    attachTenantSamlIdentityProviders(stack, userPool, cfnClient, [
      { name: "tenant-entra", metadataUrl: "https://meta", emailDomains: ["acme.example"] },
    ]);
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["COGNITO", "tenant-entra"],
    });
  });
});
