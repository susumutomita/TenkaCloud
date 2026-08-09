import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  UpdateIdentityProviderCommand,
  type UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowCognitoOnClient,
  attachSamlToClient,
  deleteSamlProvider,
  enforceSamlOnlyOnClient,
  extractUserPoolIdFromIss,
  upsertSamlProvider,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/cognito-saml";
import {
  handleDeleteTenantSamlConfig,
  handleGetTenantSamlConfig,
  handlePutTenantSamlConfig,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-routes";
import {
  deleteTenantSamlConfig,
  getTenantSamlConfig,
  putTenantSamlConfig,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-store";
import {
  normalizeAttributeMapping,
  TenantSamlConfigInputSchema,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-types";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #839 follow-up Phase B: tenant-managed SAML 設定の handler / SDK wrapper / DDB store / schema を
 * 単体テストで pin する。 Lambda 統合は別途 deploy で確認、 ここでは pure ロジックを保証する。
 */

describe("TenantSamlConfigInputSchema (Zod)", () => {
  it("should pass through when metadataUrl is HTTPS", () => {
    const r = TenantSamlConfigInputSchema.safeParse({
      metadataUrl: "https://idp.example.com/metadata.xml",
    });
    expect(r.success).toBe(true);
  });

  it("should reject HTTP metadataUrl (no plaintext metadata path)", () => {
    const r = TenantSamlConfigInputSchema.safeParse({
      metadataUrl: "http://idp.example.com/metadata.xml",
    });
    expect(r.success).toBe(false);
  });

  it("providerName should be restricted to 3-32 chars of alphanumerics + -_", () => {
    expect(
      TenantSamlConfigInputSchema.safeParse({
        metadataUrl: "https://idp.example.com/metadata.xml",
        providerName: "Acme_SAML-1",
      }).success,
    ).toBe(true);
    expect(
      TenantSamlConfigInputSchema.safeParse({
        metadataUrl: "https://idp.example.com/metadata.xml",
        providerName: "ab",
      }).success,
    ).toBe(false);
    expect(
      TenantSamlConfigInputSchema.safeParse({
        metadataUrl: "https://idp.example.com/metadata.xml",
        providerName: "Acme SAML",
      }).success,
    ).toBe(false);
  });

  it("attributeMapping は 32 entries までを許容し、 33 で reject", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 33; i++) big[`k${i}`] = `v${i}`;
    expect(
      TenantSamlConfigInputSchema.safeParse({
        metadataUrl: "https://idp.example.com/metadata.xml",
        attributeMapping: big,
      }).success,
    ).toBe(false);
  });
});

describe("normalizeAttributeMapping", () => {
  it("should return only the default email mapping when undefined", () => {
    expect(normalizeAttributeMapping(undefined)).toEqual({
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    });
  });

  it("caller email override should win over the default (e.g. Entra ID)", () => {
    expect(normalizeAttributeMapping({ email: "urn:custom:user/email" })).toEqual({
      email: "urn:custom:user/email",
    });
  });

  it("default にない key (= name 等) を追加できる", () => {
    expect(normalizeAttributeMapping({ name: "urn:custom:user/name" })).toMatchObject({
      email: expect.any(String),
      name: "urn:custom:user/name",
    });
  });
});

describe("extractUserPoolIdFromIss", () => {
  it("正常な Cognito iss から userPoolId を抽出する", () => {
    expect(
      extractUserPoolIdFromIss(
        "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_AbCdEfG12",
      ),
    ).toBe("ap-northeast-1_AbCdEfG12");
  });

  it("should return undefined for undefined / empty string / invalid URL", () => {
    expect(extractUserPoolIdFromIss(undefined)).toBeUndefined();
    expect(extractUserPoolIdFromIss("")).toBeUndefined();
    expect(extractUserPoolIdFromIss("https://example.com")).toBeUndefined();
    expect(extractUserPoolIdFromIss("not-a-url")).toBeUndefined();
  });

  // #1391: this extraction is the runtime self-targeting control behind the (architecturally
  // required) `cognito-idp:*` on `userpool/*` IAM grant — the Lambda mutates only the pool that
  // issued the caller's (API-GW-signature-validated) JWT. These adversarial cases pin that an
  // attacker cannot steer the extracted pool id to a victim pool via a crafted iss.
  it.each([
    ["http (not https) scheme", "http://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_x"],
    [
      "suffix-domain spoof",
      "https://cognito-idp.ap-northeast-1.amazonaws.com.evil.com/ap-northeast-1_x",
    ],
    [
      "extra path segment / traversal",
      "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_x/../victim_pool",
    ],
    [
      "query string appended",
      "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_x?next=victim",
    ],
    [
      "embedded userinfo host spoof",
      "https://cognito-idp.ap-northeast-1.amazonaws.com@evil.com/victim_pool",
    ],
    ["non-cognito host", "https://login.evil.com/ap-northeast-1_x"],
  ])("should return undefined for a spoofed iss: %s", (_, iss) => {
    expect(extractUserPoolIdFromIss(iss)).toBeUndefined();
  });

  it("should extract only the final pool-id segment exactly (no host/region carry-over)", () => {
    expect(
      extractUserPoolIdFromIss("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool9"),
    ).toBe("us-east-1_Pool9");
  });
});

/* ------------------------- Cognito SDK wrapper tests ------------------------- */

function makeCognitoDeps() {
  const send = vi.fn();
  return {
    send,
    deps: {
      client: { send },
      userPoolId: "ap-northeast-1_PoolID",
      userPoolClientId: "AbcdefClientId",
    },
  };
}

describe("upsertSamlProvider", () => {
  it("should send UpdateIdentityProviderCommand when the provider already exists (Describe succeeds)", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({}); // describe ok
    send.mockResolvedValueOnce({}); // update
    await upsertSamlProvider(deps, {
      providerName: "AcmeSAML",
      metadataUrl: "https://idp/m.xml",
      attributeMapping: { email: "claim" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(DescribeIdentityProviderCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateIdentityProviderCommand);
  });

  it("should fall through to CreateIdentityProviderCommand on Describe ResourceNotFoundException", async () => {
    const { send, deps } = makeCognitoDeps();
    const err = new Error("not found") as Error & { name?: string };
    err.name = "ResourceNotFoundException";
    send.mockRejectedValueOnce(err);
    send.mockResolvedValueOnce({});
    await upsertSamlProvider(deps, {
      providerName: "AcmeSAML",
      metadataUrl: "https://idp/m.xml",
      attributeMapping: {},
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateIdentityProviderCommand);
  });
});

describe("attachSamlToClient", () => {
  it("既に SAML が含まれていれば update を送らない (idempotent)", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({
      UserPoolClient: { SupportedIdentityProviders: ["COGNITO", "AcmeSAML"] },
    });
    await attachSamlToClient(deps, "AcmeSAML");
    expect(send).toHaveBeenCalledTimes(1); // Describe のみ
  });

  it("含まれていなければ Update で SAML を追加 (COGNITO は維持)", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({
      UserPoolClient: {
        SupportedIdentityProviders: ["COGNITO"],
        ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH"],
        CallbackURLs: ["https://app.example.com/callback"],
      },
    });
    send.mockResolvedValueOnce({});
    await attachSamlToClient(deps, "AcmeSAML");
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[1][0] as UpdateUserPoolClientCommand;
    expect(cmd.input.SupportedIdentityProviders).toContain("COGNITO");
    expect(cmd.input.SupportedIdentityProviders).toContain("AcmeSAML");
  });
});

describe("enforceSamlOnlyOnClient", () => {
  it("SAML 単独 + ExplicitAuthFlows=REFRESH_TOKEN のみで Update", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({
      UserPoolClient: {
        SupportedIdentityProviders: ["COGNITO", "AcmeSAML"],
        ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_USER_PASSWORD_AUTH"],
        CallbackURLs: [],
      },
    });
    send.mockResolvedValueOnce({});
    await enforceSamlOnlyOnClient(deps, "AcmeSAML");
    const cmd = send.mock.calls[1][0] as UpdateUserPoolClientCommand;
    expect(cmd.input.SupportedIdentityProviders).toEqual(["AcmeSAML"]);
    expect(cmd.input.ExplicitAuthFlows).toEqual(["ALLOW_REFRESH_TOKEN_AUTH"]);
  });
});

describe("allowCognitoOnClient", () => {
  it("SAML を外し COGNITO を必ず復元 + ExplicitAuthFlows を SRP/REFRESH_TOKEN で復元", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({
      UserPoolClient: {
        SupportedIdentityProviders: ["AcmeSAML"], // SAML only
        ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
        CallbackURLs: [],
      },
    });
    send.mockResolvedValueOnce({});
    await allowCognitoOnClient(deps, "AcmeSAML");
    const cmd = send.mock.calls[1][0] as UpdateUserPoolClientCommand;
    expect(cmd.input.SupportedIdentityProviders).toContain("COGNITO");
    expect(cmd.input.SupportedIdentityProviders).not.toContain("AcmeSAML");
    expect(cmd.input.ExplicitAuthFlows).toEqual([
      "ALLOW_USER_SRP_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
    ]);
  });

  it("ROPC (USER_PASSWORD_AUTH) を復元しない", async () => {
    // この test は以前 `toContain("ALLOW_USER_PASSWORD_AUTH")` で**復元されること**を
    // 固定していた。 意図を反転させた理由を残す。
    //
    // `ALLOW_USER_PASSWORD_AUTH` は username / password をそのまま `InitiateAuth` へ送る
    // Cognito 版の ROPC で、 RFC 9700 (BCP 240, 2025) が MUST NOT と規定した grant にあたる。
    // 復元の目的は「SAML を外したときに誰も入れなくなるのを防ぐ」ことで、 それは
    // `ALLOW_USER_SRP_AUTH` だけで果たせる (同じくパスワードで sign-in できるが、 パスワード
    // 自体をサーバへ送らない)。 リポジトリ内に USER_PASSWORD_AUTH で認証する経路は無く、
    // SAML を外すたびに使われない ROPC が復活していた。
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({
      UserPoolClient: {
        SupportedIdentityProviders: ["AcmeSAML"],
        // 直前の状態に ROPC が残っていても、 復元先には持ち込まない。
        ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"],
        CallbackURLs: [],
      },
    });
    send.mockResolvedValueOnce({});
    await allowCognitoOnClient(deps, "AcmeSAML");
    const cmd = send.mock.calls[1][0] as UpdateUserPoolClientCommand;
    expect(cmd.input.ExplicitAuthFlows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
    // lock-out 防止という本来の目的は満たされていること。
    expect(cmd.input.ExplicitAuthFlows).toContain("ALLOW_USER_SRP_AUTH");
  });
});

describe("deleteSamlProvider", () => {
  it("ResourceNotFound は silent skip (idempotent)", async () => {
    const { send, deps } = makeCognitoDeps();
    const err = new Error("not found") as Error & { name?: string };
    err.name = "ResourceNotFoundException";
    send.mockRejectedValueOnce(err);
    await expect(deleteSamlProvider(deps, "AcmeSAML")).resolves.toBeUndefined();
  });

  it("通常は DeleteIdentityProviderCommand を送る", async () => {
    const { send, deps } = makeCognitoDeps();
    send.mockResolvedValueOnce({});
    await deleteSamlProvider(deps, "AcmeSAML");
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteIdentityProviderCommand);
  });
});

/* ----------------------- DDB store + handler integration ----------------------- */

function makeSharedAndDdb() {
  const ddbSend = vi.fn();
  const cognitoSend = vi.fn();
  const shared: CompetitorAccountsSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestCompetitorAccounts",
    env: "development",
    tenkaCloudAccountId: "123456789012",
    ddb: { send: ddbSend } as unknown as CompetitorAccountsSharedResources["ddb"],
    ssm: {} as unknown as CompetitorAccountsSharedResources["ssm"],
    sts: {} as unknown as CompetitorAccountsSharedResources["sts"],
    cognito: { send: cognitoSend } as unknown as CompetitorAccountsSharedResources["cognito"],
  };
  return { shared, ddbSend, cognitoSend };
}

describe("saml-store DDB CRUD", () => {
  let shared: CompetitorAccountsSharedResources;
  let ddbSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const built = makeSharedAndDdb();
    shared = built.shared;
    ddbSend = built.ddbSend;
  });
  afterEach(() => ddbSend.mockReset());

  it("getTenantSamlConfig: 行 不在なら undefined", async () => {
    ddbSend.mockResolvedValueOnce({});
    const r = await getTenantSamlConfig(
      { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
      "t1",
    );
    expect(r).toBeUndefined();
    const cmd = ddbSend.mock.calls[0][0] as GetCommand;
    expect(cmd.input.Key).toEqual({ PK: "TENANT#t1", SK: "SAML_CONFIG" });
  });

  it("getTenantSamlConfig: core 揃っている row は enabled:true で view にマップ", async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        PK: "TENANT#t1",
        SK: "SAML_CONFIG",
        metadataUrl: "https://idp/m.xml",
        providerName: "AcmeSAML",
        attributeMapping: { email: "claim" },
        enforceSamlOnly: false,
        updatedAt: "2026-05-16T00:00:00Z",
        updatedBy: "sub-1",
      },
    });
    const r = await getTenantSamlConfig(
      { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
      "t1",
    );
    expect(r?.enabled).toBe(true);
    expect(r?.metadataUrl).toBe("https://idp/m.xml");
  });

  it("putTenantSamlConfig: PutCommand を発行し view を返す", async () => {
    ddbSend.mockResolvedValueOnce({});
    const r = await putTenantSamlConfig(
      { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
      "t1",
      {
        metadataUrl: "https://idp/m.xml",
        providerName: "AcmeSAML",
        attributeMapping: { email: "claim" },
        enforceSamlOnly: true,
      },
      { updatedAt: "2026-05-16T00:00:00Z", updatedBy: "sub-1" },
    );
    expect(r.enabled).toBe(true);
    expect(r.enforceSamlOnly).toBe(true);
    const cmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      PK: "TENANT#t1",
      SK: "SAML_CONFIG",
      providerName: "AcmeSAML",
    });
  });

  it("deleteTenantSamlConfig: DeleteCommand を発行 (idempotent)", async () => {
    ddbSend.mockResolvedValueOnce({});
    await deleteTenantSamlConfig(
      { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
      "t1",
    );
    const cmd = ddbSend.mock.calls[0][0] as DeleteCommand;
    expect(cmd.input.Key).toEqual({ PK: "TENANT#t1", SK: "SAML_CONFIG" });
  });
});

describe("handleGetTenantSamlConfig", () => {
  it("DDB row 不在なら enabled:false の view を 200 で返す", async () => {
    const { shared, ddbSend } = makeSharedAndDdb();
    ddbSend.mockResolvedValueOnce({});
    const r = await handleGetTenantSamlConfig(shared, "t1");
    expect(r.status).toBe(StatusCodes.OK);
    expect(r.body).toEqual({ enabled: false });
  });

  it("DDB row 存在なら enabled:true の view を 200 で返す", async () => {
    const { shared, ddbSend } = makeSharedAndDdb();
    ddbSend.mockResolvedValueOnce({
      Item: {
        PK: "TENANT#t1",
        SK: "SAML_CONFIG",
        metadataUrl: "https://idp/m.xml",
        providerName: "AcmeSAML",
        attributeMapping: { email: "claim" },
        enforceSamlOnly: false,
        updatedAt: "2026-05-16T00:00:00Z",
        updatedBy: "sub",
      },
    });
    const r = await handleGetTenantSamlConfig(shared, "t1");
    expect(r.status).toBe(StatusCodes.OK);
    expect((r.body as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("handlePutTenantSamlConfig", () => {
  it("should return 400 without calling Cognito / DDB on validation failure", async () => {
    const { shared, ddbSend, cognitoSend } = makeSharedAndDdb();
    const r = await handlePutTenantSamlConfig(
      shared,
      {
        client: { send: cognitoSend },
        userPoolId: "p",
        userPoolClientId: "c",
      },
      { tenantId: "t1", updatedBy: "sub", nowIso: "2026-05-16T00:00:00Z" },
      { metadataUrl: "http://insecure" }, // HTTP は reject
    );
    expect(r.status).toBe(StatusCodes.BAD_REQUEST);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  it("正常系 (enforceSamlOnly=false): IdP describe → create → SupportedIdentityProviders update → DDB put の順", async () => {
    const { shared, ddbSend, cognitoSend } = makeSharedAndDdb();
    // 1) describe -> not found, 2) create, 3) describe userPoolClient, 4) update userPoolClient
    const notFound = new Error("not found") as Error & { name?: string };
    notFound.name = "ResourceNotFoundException";
    cognitoSend.mockRejectedValueOnce(notFound);
    cognitoSend.mockResolvedValueOnce({});
    cognitoSend.mockResolvedValueOnce({
      UserPoolClient: { SupportedIdentityProviders: ["COGNITO"], ExplicitAuthFlows: [] },
    });
    cognitoSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({}); // PutCommand

    const r = await handlePutTenantSamlConfig(
      shared,
      {
        client: { send: cognitoSend },
        userPoolId: "p",
        userPoolClientId: "c",
      },
      { tenantId: "t1", updatedBy: "sub", nowIso: "2026-05-16T00:00:00Z" },
      {
        metadataUrl: "https://idp.example.com/metadata.xml",
        providerName: "AcmeSAML",
        enforceSamlOnly: false,
      },
    );
    expect(r.status).toBe(StatusCodes.OK);
    expect((r.body as { enabled: boolean }).enabled).toBe(true);
    expect(cognitoSend).toHaveBeenCalledTimes(4);
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should call enforceSamlOnlyOnClient (SupportedIdentityProviders=[SAML] only) when enforceSamlOnly=true", async () => {
    const { shared, ddbSend, cognitoSend } = makeSharedAndDdb();
    cognitoSend.mockResolvedValueOnce({}); // describe IdP ok (= exists)
    cognitoSend.mockResolvedValueOnce({}); // update IdP
    cognitoSend.mockResolvedValueOnce({
      UserPoolClient: { SupportedIdentityProviders: ["COGNITO", "AcmeSAML"] },
    });
    cognitoSend.mockResolvedValueOnce({}); // update client
    ddbSend.mockResolvedValueOnce({});

    await handlePutTenantSamlConfig(
      shared,
      {
        client: { send: cognitoSend },
        userPoolId: "p",
        userPoolClientId: "c",
      },
      { tenantId: "t1", updatedBy: "sub", nowIso: "2026-05-16T00:00:00Z" },
      {
        metadataUrl: "https://idp.example.com/metadata.xml",
        providerName: "AcmeSAML",
        enforceSamlOnly: true,
      },
    );
    const updateClientCmd = cognitoSend.mock.calls[3][0] as UpdateUserPoolClientCommand;
    expect(updateClientCmd.input.SupportedIdentityProviders).toEqual(["AcmeSAML"]);
    expect(updateClientCmd.input.ExplicitAuthFlows).toEqual(["ALLOW_REFRESH_TOKEN_AUTH"]);
  });
});

describe("handleDeleteTenantSamlConfig", () => {
  it("UserPoolClient revert → IdP delete → DDB delete の順、 200 を返す (idempotent)", async () => {
    const { shared, ddbSend, cognitoSend } = makeSharedAndDdb();
    ddbSend.mockResolvedValueOnce({}); // get existing → no row
    cognitoSend.mockResolvedValueOnce({
      UserPoolClient: { SupportedIdentityProviders: ["COGNITO", "CompanySAML"] },
    });
    cognitoSend.mockResolvedValueOnce({}); // update client
    cognitoSend.mockResolvedValueOnce({}); // delete IdP
    ddbSend.mockResolvedValueOnce({}); // delete row

    const r = await handleDeleteTenantSamlConfig(
      shared,
      { client: { send: cognitoSend }, userPoolId: "p", userPoolClientId: "c" },
      { tenantId: "t1", updatedBy: "sub", nowIso: "2026-05-16T00:00:00Z" },
    );

    expect(r.status).toBe(StatusCodes.OK);
    expect((r.body as { deleted: boolean }).deleted).toBe(true);
    // 4 cognito calls (Describe + Update for revert, Delete IdP) + 2 DDB calls (Get + Delete)
    expect(cognitoSend).toHaveBeenCalledTimes(3);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });
});
