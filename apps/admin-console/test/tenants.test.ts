import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client";
import {
  buildCodeBuildBuildUrl,
  createTenant,
  deleteTenant,
  listTenants,
  parseTenantConfig,
} from "../src/api/tenants";

function buildApiMock(overrides: Partial<ApiClient> = {}): {
  api: ApiClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  const post = vi.fn();
  const del = vi.fn();
  const api: ApiClient = { get, post, del, ...overrides };
  return { api, get, post, del };
}

describe("createTenant", () => {
  describe("SBT v0.3.9 の POST /tenants で onboarding を起動させるとき", () => {
    it("POST /tenants に飛ばすべき", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantName: "品質管理部",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "In progress",
        },
      });

      await createTenant(api, { tenantName: "品質管理部", email: "a@b.com", tier: "basic" });

      expect(post).toHaveBeenCalledOnce();
      const [path] = post.mock.calls[0];
      expect(path).toBe("tenants");
    });

    it("body は flat shape で送るべき (tenantName / email / tier / tenantStatus)", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantName: "品質管理部",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "In progress",
        },
      });

      await createTenant(api, { tenantName: "品質管理部", email: "a@b.com", tier: "basic" });

      const [, body] = post.mock.calls[0];
      expect(body).toEqual({
        tenantName: "品質管理部",
        email: "a@b.com",
        tier: "basic",
        tenantStatus: "In progress",
      });
    });

    it("tenantStatus の初期値は 'In progress' 固定であるべき", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantName: "X",
          email: "a@b.com",
          tier: "platinum",
          tenantStatus: "In progress",
        },
      });

      await createTenant(api, { tenantName: "X", email: "a@b.com", tier: "platinum" });

      const [, body] = post.mock.calls[0] as [string, { tenantStatus: string }];
      expect(body.tenantStatus).toBe("In progress");
    });

    it("brokerEntraProfileId が指定されたら onboarding body に含めるべき", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantName: "X",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "In progress",
        },
      });

      await createTenant(api, {
        tenantName: "X",
        email: "a@b.com",
        tier: "basic",
        brokerEntraProfileId: "contoso",
      });

      const [, body] = post.mock.calls[0] as [string, { brokerEntraProfileId: string }];
      expect(body.brokerEntraProfileId).toBe("contoso");
    });
  });

  describe("サーバが data を返すとき", () => {
    it("data 中の tenant を返すべき", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantName: "X",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "In progress",
        },
      });

      const res = await createTenant(api, { tenantName: "X", email: "a@b.com", tier: "basic" });

      expect(res.tenantId).toBe("t-1");
      expect(res.tenantStatus).toBe("In progress");
    });
  });

  describe("サーバがエラーを投げたとき", () => {
    it("そのまま伝搬すべき", async () => {
      const { api, post } = buildApiMock();
      post.mockRejectedValueOnce(new Error("API 500"));

      await expect(
        createTenant(api, { tenantName: "X", email: "a@b.com", tier: "basic" }),
      ).rejects.toThrow("API 500");
    });
  });
});

describe("listTenants", () => {
  describe("サーバが `{data: [...]}` を返すとき", () => {
    it("data 配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce({
        data: [
          {
            tenantId: "t-1",
            tenantName: "A",
            email: "a@b.com",
            tier: "basic",
            tenantStatus: "Complete",
          },
        ],
      });

      const res = await listTenants(api);

      expect(res).toHaveLength(1);
      expect(res[0].tenantId).toBe("t-1");
    });
  });

  describe("サーバが配列を直接返すとき", () => {
    it("その配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce([
        {
          tenantId: "t-1",
          tenantName: "A",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "Complete",
        },
      ]);

      const res = await listTenants(api);

      expect(res).toHaveLength(1);
    });
  });

  describe("サーバが data 無しで返すとき", () => {
    it("空配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce({});

      const res = await listTenants(api);

      expect(res).toEqual([]);
    });
  });
});

describe("deleteTenant", () => {
  describe("SBT の /tenants DELETE を叩くとき", () => {
    it("`tenants/<id>` パスを URL エンコードして呼ぶべき", async () => {
      const { api, del } = buildApiMock();
      del.mockResolvedValueOnce(undefined);

      await deleteTenant(api, "tenant with space");

      expect(del).toHaveBeenCalledWith("tenants/tenant%20with%20space");
    });
  });
});

describe("parseTenantConfig", () => {
  describe("provision-tenant.sh が出力する完全な JSON を渡したとき", () => {
    it("4 フィールド全部 (userPoolId / appClientId / apiGatewayUrl / applicationAdminConsoleUrl) を返すべき", () => {
      const raw = JSON.stringify({
        userPoolId: "ap-northeast-1_xxx",
        appClientId: "abc",
        apiGatewayUrl: "https://api.example.com/",
        applicationAdminConsoleUrl: "https://d123abc.cloudfront.net",
      });
      const parsed = parseTenantConfig(raw);
      expect(parsed.userPoolId).toBe("ap-northeast-1_xxx");
      expect(parsed.appClientId).toBe("abc");
      expect(parsed.apiGatewayUrl).toBe("https://api.example.com/");
      expect(parsed.applicationAdminConsoleUrl).toBe("https://d123abc.cloudfront.net");
    });
  });

  describe("undefined を渡したとき", () => {
    it("空オブジェクトを返すべき", () => {
      expect(parseTenantConfig(undefined)).toEqual({});
    });
  });

  describe("不正な JSON 文字列を渡したとき", () => {
    it("空オブジェクトにフォールバックすべき (例外を投げない)", () => {
      expect(parseTenantConfig("not json")).toEqual({});
    });
  });

  describe("一部フィールドだけの JSON を渡したとき", () => {
    it("欠落フィールドは undefined のまま、存在するフィールドは取れるべき", () => {
      const raw = JSON.stringify({ userPoolId: "p" });
      const parsed = parseTenantConfig(raw);
      expect(parsed.userPoolId).toBe("p");
      expect(parsed.applicationAdminConsoleUrl).toBeUndefined();
    });
  });

  describe("#57 で追加した provisioning 情報", () => {
    it("provisioningBuildId / projectName / region / accountId を返すべき", () => {
      const raw = JSON.stringify({
        provisioningBuildId: "proj:abcd-1234",
        provisioningProjectName: "proj",
        provisioningRegion: "ap-northeast-1",
        provisioningAccountId: "123456789012",
      });
      const parsed = parseTenantConfig(raw);
      expect(parsed.provisioningBuildId).toBe("proj:abcd-1234");
      expect(parsed.provisioningProjectName).toBe("proj");
      expect(parsed.provisioningRegion).toBe("ap-northeast-1");
      expect(parsed.provisioningAccountId).toBe("123456789012");
    });
  });
});

describe("buildCodeBuildBuildUrl", () => {
  describe("必須 4 要素が全部揃っているとき", () => {
    it("AWS Console CodeBuild build の deep link URL を返すべき", () => {
      const url = buildCodeBuildBuildUrl({
        buildId: "proj:abcd-1234",
        projectName: "proj",
        region: "ap-northeast-1",
        accountId: "123456789012",
      });
      expect(url).toBe(
        "https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/123456789012/projects/proj/build/proj%3Aabcd-1234/?region=ap-northeast-1",
      );
    });

    it("buildId 中の `:` を URL エンコード (%3A) すべき", () => {
      const url = buildCodeBuildBuildUrl({
        buildId: "proj:uuid",
        projectName: "proj",
        region: "us-east-1",
        accountId: "111",
      });
      expect(url).toContain("%3A");
      expect(url).not.toContain("proj:uuid/");
    });
  });

  describe("buildId が undefined / unknown のとき", () => {
    it("undefined で null を返すべき", () => {
      expect(
        buildCodeBuildBuildUrl({
          buildId: undefined,
          projectName: "proj",
          region: "ap-northeast-1",
          accountId: "111",
        }),
      ).toBeNull();
    });

    it("'unknown' リテラルで null を返すべき (install.sh fallback 値)", () => {
      expect(
        buildCodeBuildBuildUrl({
          buildId: "unknown",
          projectName: "proj",
          region: "ap-northeast-1",
          accountId: "111",
        }),
      ).toBeNull();
    });
  });

  describe("いずれかの要素が空文字のとき", () => {
    it("null を返すべき (region 空)", () => {
      expect(
        buildCodeBuildBuildUrl({
          buildId: "proj:uuid",
          projectName: "proj",
          region: "",
          accountId: "111",
        }),
      ).toBeNull();
    });
  });
});
