import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { type CfnUserPoolClient, UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import {
  attachSamlIdentityProviders,
  parseSamlIdpConfig,
} from "../../lib/control-plane/saml-identity-providers";

/**
 * Issue #1335 Phase 1: SAML IdP env parsing + CDK attach。 ProtoShip 移植時に契約が
 * silently に drift しないよう pinning する。
 */
describe("parseSamlIdpConfig (#1335)", () => {
  it("should return empty array for undefined / empty / whitespace input", () => {
    expect(parseSamlIdpConfig(undefined)).toEqual([]);
    expect(parseSamlIdpConfig("")).toEqual([]);
    expect(parseSamlIdpConfig("   ")).toEqual([]);
  });

  it("should parse a valid single-IdP JSON array", () => {
    const raw = JSON.stringify([
      {
        name: "corp-entra",
        metadataUrl: "https://example/meta.xml",
        emailDomains: ["example.com"],
      },
    ]);
    const out = parseSamlIdpConfig(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("corp-entra");
    expect(out[0]?.emailDomains).toEqual(["example.com"]);
  });

  it("should allow multiple IdPs sharing the same email domain", () => {
    const raw = JSON.stringify([
      { name: "corp-entra", metadataUrl: "https://a/meta", emailDomains: ["example.com"] },
      { name: "corp-okta", metadataUrl: "https://b/meta", emailDomains: ["example.com"] },
    ]);
    expect(parseSamlIdpConfig(raw)).toHaveLength(2);
  });

  it("should fail-loud on invalid JSON (= silent fallback would mask misconfig)", () => {
    expect(() => parseSamlIdpConfig("not-json")).toThrow(/is not valid JSON/);
  });

  it("should reject non-array JSON", () => {
    expect(() => parseSamlIdpConfig(JSON.stringify({ foo: "bar" }))).toThrow(
      /must be a JSON array/,
    );
  });

  it("should reject metadataUrl that is not https", () => {
    const raw = JSON.stringify([
      { name: "corp-entra", metadataUrl: "http://insecure/meta", emailDomains: ["example.com"] },
    ]);
    expect(() => parseSamlIdpConfig(raw)).toThrow(/metadataUrl must be an https URL/);
  });

  it("should reject provider name that violates the regex (= shape contract)", () => {
    const raw = JSON.stringify([
      { name: "no", metadataUrl: "https://x/meta", emailDomains: ["example.com"] },
    ]);
    expect(() => parseSamlIdpConfig(raw)).toThrow(/name must match/);
  });

  it("should reject empty emailDomains list", () => {
    const raw = JSON.stringify([
      { name: "corp-entra", metadataUrl: "https://x/meta", emailDomains: [] },
    ]);
    expect(() => parseSamlIdpConfig(raw)).toThrow(/emailDomains must list at least one domain/);
  });

  it("should surface the env var name in error messages for ops debuggability", () => {
    expect(() => parseSamlIdpConfig("bad", "TENANT_SAML_IDPS")).toThrow(/TENANT_SAML_IDPS/);
  });
});

describe("attachSamlIdentityProviders (CDK) (#1335)", () => {
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
    const directory = attachSamlIdentityProviders(stack, userPool, cfnClient, []);
    expect(directory).toEqual({});
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  it("should attach 1 IdP and produce a domain → [provider] HRD directory", () => {
    const { stack, userPool, cfnClient } = makeStack();
    const directory = attachSamlIdentityProviders(stack, userPool, cfnClient, [
      { name: "corp-entra", metadataUrl: "https://meta", emailDomains: ["example.com"] },
    ]);
    expect(directory).toEqual({ "example.com": ["corp-entra"] });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    tpl.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "corp-entra",
      ProviderType: "SAML",
    });
  });

  it("should collapse multiple IdPs on the same domain into one HRD entry with both provider names", () => {
    const { stack, userPool, cfnClient } = makeStack();
    const directory = attachSamlIdentityProviders(stack, userPool, cfnClient, [
      { name: "corp-entra", metadataUrl: "https://a", emailDomains: ["example.com"] },
      { name: "corp-okta", metadataUrl: "https://b", emailDomains: ["example.com"] },
    ]);
    expect(directory["example.com"]).toEqual(["corp-entra", "corp-okta"]);
    Template.fromStack(stack).resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 2);
  });

  it("should keep COGNITO in SupportedIdentityProviders so local auth is preserved", () => {
    const { stack, userPool, cfnClient } = makeStack();
    attachSamlIdentityProviders(stack, userPool, cfnClient, [
      { name: "corp-entra", metadataUrl: "https://meta", emailDomains: ["example.com"] },
    ]);
    const tpl = Template.fromStack(stack);
    // SupportedIdentityProviders is overridden via addPropertyOverride
    tpl.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["COGNITO", "corp-entra"],
    });
  });
});
