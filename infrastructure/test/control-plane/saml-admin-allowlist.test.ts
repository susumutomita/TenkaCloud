import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { describe, expect, it } from "vitest";
import {
  attachFederatedAdminAllowlist,
  PRE_SIGNUP_HANDLER,
  parseAdminAllowlist,
} from "../../lib/control-plane/saml-admin-allowlist";

/**
 * Issue #1335 Phase 1: provider 束縛 allowlist の parse + Lambda 配線 + sandbox 評価。
 * fail-safe 契約 (= 空 = 全拒否) と provider 跨ぎ詐称防止が drift しないよう pinning する。
 */
describe("parseAdminAllowlist (#1335)", () => {
  it("should return empty array for undefined / empty / whitespace input (= fail-safe = deny all federated)", () => {
    expect(parseAdminAllowlist(undefined)).toEqual([]);
    expect(parseAdminAllowlist("")).toEqual([]);
    expect(parseAdminAllowlist("   ")).toEqual([]);
  });

  it("should parse comma-separated entries", () => {
    const out = parseAdminAllowlist("corp-entra/admin@example.com,corp-okta/dev@example.com");
    expect(out).toEqual(["corp-entra/admin@example.com", "corp-okta/dev@example.com"]);
  });

  it("should parse JSON array form", () => {
    const out = parseAdminAllowlist('["corp-entra/a@example.com"]');
    expect(out).toEqual(["corp-entra/a@example.com"]);
  });

  it("should normalize provider+email to lowercase and dedupe", () => {
    const out = parseAdminAllowlist("Corp-Entra/Admin@Example.com,corp-entra/admin@example.com");
    expect(out).toEqual(["corp-entra/admin@example.com"]);
  });

  it("should fail-loud when an entry is missing the slash", () => {
    expect(() => parseAdminAllowlist("corp-entra-admin@example.com")).toThrow(
      /must be 'provider\/email'/,
    );
  });

  it("should reject malformed email", () => {
    expect(() => parseAdminAllowlist("corp-entra/not-an-email")).toThrow(/email is invalid/);
  });

  it("should reject malformed provider name", () => {
    expect(() => parseAdminAllowlist("ab/admin@example.com")).toThrow(/provider name is invalid/);
  });

  it("#1386: should reject a provider name containing an underscore (prefix-collision avenue)", () => {
    // `_` を provider 名に許すと `{provider}_{subject}` の境界が曖昧になり `corp` と `corp_evil` が
    // 衝突しうる。 parse 時点で fail-loud に弾くことで誤マッチ経路を物理的に塞ぐ。
    expect(() => parseAdminAllowlist("corp_evil/admin@example.com")).toThrow(
      /provider name is invalid/,
    );
  });

  it("should surface the env var name in error messages", () => {
    expect(() => parseAdminAllowlist("bad", "TENANT_SAML_ADMIN_ALLOWLIST")).toThrow(
      /TENANT_SAML_ADMIN_ALLOWLIST/,
    );
  });
});

describe("PRE_SIGNUP_HANDLER sandbox semantics (#1335)", () => {
  /**
   * 実際に Lambda に流す code 文字列を sandbox 評価し、 provider 束縛 allowlist の挙動を
   * 検証する (= ロジックの二重定義による drift を避けるため inline 文字列を直接読む)。
   */
  function evalHandler(allowlist: string): (event: unknown) => Promise<unknown> {
    const exportsBag: { handler?: (event: unknown) => Promise<unknown> } = {};
    const factory = new Function(
      "exports",
      "process",
      `${PRE_SIGNUP_HANDLER}; return exports.handler;`,
    );
    const handler = factory(exportsBag, { env: { ADMIN_ALLOWLIST: allowlist } }) as (
      event: unknown,
    ) => Promise<unknown>;
    return handler;
  }

  const externalEvent = (userName: string, email: string) => ({
    triggerSource: "PreSignUp_ExternalProvider",
    userName,
    request: { userAttributes: { email } },
  });

  it("should accept federated user whose provider+email matches allowlist", async () => {
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(
      handler(externalEvent("corp-entra_subject-abc", "admin@example.com")),
    ).resolves.toBeTruthy();
  });

  it("should reject federated user whose email matches but provider does NOT (= cross-provider spoofing)", async () => {
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(
      handler(externalEvent("corp-okta_subject-xyz", "admin@example.com")),
    ).rejects.toThrow(/not authorized/);
  });

  it("#1386: should reject a sibling-prefix provider via exact {provider}_ boundary match", async () => {
    // allowlist provider = "corp-entra"。 別 provider "corp-entra2" の federated username は
    // 最初の `_` で分割した provider 部が "corp-entra2" となり、 完全一致しないので拒否される。
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(
      handler(externalEvent("corp-entra2_subject-abc", "admin@example.com")),
    ).rejects.toThrow(/not authorized/);
  });

  it("#1386: should reject a federated username with no underscore separator", async () => {
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(handler(externalEvent("corp-entra", "admin@example.com"))).rejects.toThrow(
      /not authorized/,
    );
  });

  it("should reject federated user not present in allowlist", async () => {
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(
      handler(externalEvent("corp-entra_subject-abc", "outsider@example.com")),
    ).rejects.toThrow(/not authorized/);
  });

  it("should reject ALL federated sign-ups when allowlist is empty (= fail-safe)", async () => {
    const handler = evalHandler("");
    await expect(
      handler(externalEvent("corp-entra_subject-abc", "admin@example.com")),
    ).rejects.toThrow(/not authorized/);
  });

  it("should not affect non-external triggers (= AdminCreateUser path stays open)", async () => {
    const handler = evalHandler("corp-entra/admin@example.com");
    await expect(
      handler({ triggerSource: "PreSignUp_AdminCreateUser", request: { userAttributes: {} } }),
    ).resolves.toBeTruthy();
  });
});

describe("attachFederatedAdminAllowlist (CDK) (#1335)", () => {
  it("should attach a Pre sign-up Lambda trigger on the UserPool with the allowlist env", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    attachFederatedAdminAllowlist(stack, userPool, ["corp-entra/admin@example.com"]);
    const tpl = Template.fromStack(stack);
    // Lambda created with the inline pre-signup handler
    tpl.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          ADMIN_ALLOWLIST: "corp-entra/admin@example.com",
        },
      },
    });
    // UserPool now references a PreSignUp trigger.
    tpl.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: {
        PreSignUp: {},
      },
    });
  });

  it("should still attach the trigger when allowlist is empty (= fail-safe deny-all)", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    const userPool = new UserPool(stack, "Pool");
    attachFederatedAdminAllowlist(stack, userPool, []);
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::Lambda::Function", 1);
  });
});
