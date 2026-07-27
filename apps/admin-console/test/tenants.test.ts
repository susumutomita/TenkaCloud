import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client";
import {
  buildCodeBuildBuildUrl,
  createTenant,
  deleteTenant,
  isTenantSuspended,
  listTenants,
  parseTenantConfig,
  tenantStatusBadgeColor,
  tierBadgeColor,
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
  describe("when starting onboarding via the SBT v0.9.5 tenant-registration API", () => {
    it("should send a POST to /tenant-registrations", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantRegistrationId: "r-1",
        },
      });

      await createTenant(api, { tenantName: "ACME 株式会社", email: "a@b.com", tier: "basic" });

      expect(post).toHaveBeenCalledOnce();
      const [path] = post.mock.calls[0];
      expect(path).toBe("tenant-registrations");
    });

    it("should separate tenant data from tenant-registration data", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantRegistrationId: "r-1",
        },
      });

      await createTenant(api, { tenantName: "ACME 株式会社", email: "a@b.com", tier: "basic" });

      const [, body] = post.mock.calls[0];
      expect(body).toEqual({
        tenantData: {
          tenantName: "ACME 株式会社",
          email: "a@b.com",
          tier: "basic",
          tenantStatus: "In progress",
        },
        tenantRegistrationData: {
          registrationStatus: "In progress",
        },
      });
    });

    it("should fix both initial status values as 'In progress'", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantRegistrationId: "r-1",
        },
      });

      await createTenant(api, { tenantName: "X", email: "a@b.com", tier: "platinum" });

      const [, body] = post.mock.calls[0] as [
        string,
        {
          tenantData: { tenantStatus: string };
          tenantRegistrationData: { registrationStatus: string };
        },
      ];
      expect(body.tenantData.tenantStatus).toBe("In progress");
      expect(body.tenantRegistrationData.registrationStatus).toBe("In progress");
    });
  });

  describe("when the server returns data", () => {
    it("should compose the tenant from the request and returned lifecycle identifiers", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
          tenantRegistrationId: "r-1",
        },
      });

      const res = await createTenant(api, { tenantName: "X", email: "a@b.com", tier: "basic" });

      expect(res.tenantId).toBe("t-1");
      expect(res.tenantRegistrationId).toBe("r-1");
      expect(res.tenantName).toBe("X");
      expect(res.tenantStatus).toBe("In progress");
    });

    it("should fail closed when SBT omits a lifecycle identifier", async () => {
      const { api, post } = buildApiMock();
      post.mockResolvedValueOnce({
        data: {
          tenantId: "t-1",
        },
      });

      await expect(
        createTenant(api, { tenantName: "X", email: "a@b.com", tier: "basic" }),
      ).rejects.toThrow("tenantRegistrationId");
    });
  });

  describe("when the server throws an error", () => {
    it("should propagate it as-is", async () => {
      const { api, post } = buildApiMock();
      post.mockRejectedValueOnce(new Error("API 500"));

      // Issue #873: vitest 4.x `.rejects.toThrow(string)` regression を回避。
      await expect(
        createTenant(api, { tenantName: "X", email: "a@b.com", tier: "basic" }),
      ).rejects.toMatchObject({ message: "API 500" });
    });
  });
});

describe("listTenants", () => {
  it("should follow SBT pagination and normalize sbtaws_active without dropping registration ids", async () => {
    const { api, get } = buildApiMock();
    get
      .mockResolvedValueOnce({
        data: [
          {
            tenantId: "t-1",
            tenantRegistrationId: "r-1",
            tenantName: "A",
            email: "a@b.com",
            tier: "basic",
            tenantStatus: "Complete",
            sbtaws_active: false,
          },
        ],
        next_token: "t-1",
      })
      .mockResolvedValueOnce({
        data: [
          {
            tenantId: "t-2",
            tenantRegistrationId: "r-2",
            tenantName: "B",
            email: "b@b.com",
            tier: "advanced",
            tenantStatus: "Complete",
            sbtaws_active: true,
          },
        ],
      });

    const res = await listTenants(api);

    expect(get).toHaveBeenNthCalledWith(1, "tenants?limit=100");
    expect(get).toHaveBeenNthCalledWith(2, "tenants?limit=100&next_token=t-1");
    expect(res.map((tenant) => tenant.tenantRegistrationId)).toEqual(["r-1", "r-2"]);
    expect(res.map((tenant) => tenant.isActive)).toEqual([false, true]);
  });

  it("should prefer the authoritative sbtaws_active value over legacy isActive", async () => {
    const { api, get } = buildApiMock();
    get.mockResolvedValueOnce([
      {
        tenantId: "t-1",
        tenantName: "A",
        email: "a@b.com",
        tier: "basic",
        tenantStatus: "Complete",
        isActive: true,
        sbtaws_active: false,
      },
    ]);

    const res = await listTenants(api);

    expect(res[0].isActive).toBe(false);
  });

  it("should fail closed when SBT repeats a pagination token", async () => {
    const { api, get } = buildApiMock();
    get.mockResolvedValue({
      data: [],
      next_token: "repeated",
    });

    await expect(listTenants(api)).rejects.toThrow("repeated pagination token");
  });

  describe("when the server returns `{data: [...]}`", () => {
    it("should return the data array", async () => {
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

  describe("when the server returns an array directly", () => {
    it("should return that array", async () => {
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

  describe("when the server returns without data", () => {
    it("should return an empty array", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce({});

      const res = await listTenants(api);

      expect(res).toEqual([]);
    });
  });
});

describe("deleteTenant", () => {
  describe("when calling SBT's tenant-registration DELETE", () => {
    it("should URL-encode the `tenant-registrations/<registration-id>` path", async () => {
      const { api, del } = buildApiMock();
      del.mockResolvedValueOnce(undefined);

      await deleteTenant(api, {
        tenantId: "tenant-id",
        tenantRegistrationId: "registration with space",
      });

      expect(del).toHaveBeenCalledWith("tenant-registrations/registration%20with%20space");
    });

    it("should fail closed without making a request when a legacy tenant lacks registration id", async () => {
      const { api, del } = buildApiMock();

      await expect(
        deleteTenant(api, { tenantId: "legacy-tenant", tenantRegistrationId: " " }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("legacy-tenant"),
      });
      expect(del).not.toHaveBeenCalled();
    });
  });
});

describe("parseTenantConfig", () => {
  describe("when passed the full JSON that provision-tenant.sh emits", () => {
    it("should return all 4 fields (userPoolId / appClientId / apiGatewayUrl / applicationAdminConsoleUrl)", () => {
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

  describe("when passed undefined", () => {
    it("should return an empty object", () => {
      expect(parseTenantConfig(undefined)).toEqual({});
    });
  });

  describe("when passed an invalid JSON string", () => {
    it("should fall back to an empty object (without throwing)", () => {
      expect(parseTenantConfig("not json")).toEqual({});
    });
  });

  describe("when passed JSON with only some fields", () => {
    it("should leave missing fields undefined and return the present ones", () => {
      const raw = JSON.stringify({ userPoolId: "p" });
      const parsed = parseTenantConfig(raw);
      expect(parsed.userPoolId).toBe("p");
      expect(parsed.applicationAdminConsoleUrl).toBeUndefined();
    });
  });

  describe("provisioning info added in #57", () => {
    it("should return provisioningBuildId / projectName / region / accountId", () => {
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
  describe("when all 4 required elements are present", () => {
    it("should return a deep link URL to the AWS Console CodeBuild build", () => {
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

    it("should URL-encode `:` (as %3A) inside buildId", () => {
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

  describe("when buildId is undefined / unknown", () => {
    it("should return null for undefined", () => {
      expect(
        buildCodeBuildBuildUrl({
          buildId: undefined,
          projectName: "proj",
          region: "ap-northeast-1",
          accountId: "111",
        }),
      ).toBeNull();
    });

    it("should return null for the literal 'unknown' (install.sh fallback value)", () => {
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

  describe("when any element is an empty string", () => {
    it("should return null (region empty)", () => {
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

describe("tenantStatusBadgeColor", () => {
  describe("for the actual tenantStatus values that provision-tenant.sh writes", () => {
    it("should map 'Complete' to green (= provisioning complete)", () => {
      expect(tenantStatusBadgeColor("Complete")).toBe("green");
    });

    it("should map 'In progress' to blue (= provisioning in progress)", () => {
      expect(tenantStatusBadgeColor("In progress")).toBe("blue");
    });

    it("should map 'Failed' to red (= provisioning failed)", () => {
      expect(tenantStatusBadgeColor("Failed")).toBe("red");
    });

    it("should map 'Deleted' to grey (= deprovisioned tenant)", () => {
      expect(tenantStatusBadgeColor("Deleted")).toBe("grey");
    });

    it("should map 'Suspended' to red (= operations blocked)", () => {
      expect(tenantStatusBadgeColor("Suspended")).toBe("red");
    });
  });

  describe("when absorbing upper/lower case variants", () => {
    it("should return green for 'complete' (lowercase)", () => {
      expect(tenantStatusBadgeColor("complete")).toBe("green");
    });

    it("should return green for 'COMPLETE' (uppercase)", () => {
      expect(tenantStatusBadgeColor("COMPLETE")).toBe("green");
    });

    it("should return red for 'failed' (lowercase)", () => {
      expect(tenantStatusBadgeColor("failed")).toBe("red");
    });

    it("should return blue for 'in progress' (lowercase)", () => {
      expect(tenantStatusBadgeColor("in progress")).toBe("blue");
    });
  });

  describe("when an unknown value arrives", () => {
    it("should fall back to grey (= undefined state)", () => {
      expect(tenantStatusBadgeColor("Unknown")).toBe("grey");
    });

    it("should return grey for an empty string", () => {
      expect(tenantStatusBadgeColor("")).toBe("grey");
    });

    it("should return grey for strings equivalent to undefined / null", () => {
      expect(tenantStatusBadgeColor("undefined")).toBe("grey");
    });

    it('should return grey for an undefined argument (= `?? ""` fallback)', () => {
      expect(tenantStatusBadgeColor(undefined)).toBe("grey");
    });
  });
});

describe("isTenantSuspended", () => {
  it("should return true only for explicit isSuspended=true", () => {
    expect(isTenantSuspended({ isSuspended: true })).toBe(true);
    expect(isTenantSuspended({ isSuspended: false })).toBe(false);
    expect(isTenantSuspended({})).toBe(false);
  });
});

describe("tierBadgeColor", () => {
  describe("when assigning a different color to each tier", () => {
    it("should make basic grey (= pooled minimum configuration)", () => {
      expect(tierBadgeColor("basic")).toBe("grey");
    });

    it("should make advanced blue (= pooled intermediate configuration)", () => {
      expect(tierBadgeColor("advanced")).toBe("blue");
    });

    it("should make platinum green (= silo-dedicated stack)", () => {
      expect(tierBadgeColor("platinum")).toBe("green");
    });
  });

  describe("when absorbing upper/lower case variants", () => {
    it("should return green for 'PLATINUM' (consistent with provision-tenant.sh TIER uppercase comparison)", () => {
      expect(tierBadgeColor("PLATINUM")).toBe("green");
    });
  });

  describe("when an unknown tier value arrives", () => {
    it("should fall back to grey", () => {
      expect(tierBadgeColor("nonexistent")).toBe("grey");
    });

    it('should return grey for an undefined argument (= `?? ""` fallback)', () => {
      expect(tierBadgeColor(undefined)).toBe("grey");
    });
  });
});
