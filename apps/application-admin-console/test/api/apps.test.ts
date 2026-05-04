import { describe, expect, it, vi } from "vitest";
import { type App, createApp, deleteApp, listApps } from "../../src/api/apps";
import type { ApiClient } from "../../src/api/client";

function buildApiMock(): {
  api: ApiClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  const post = vi.fn();
  const del = vi.fn();
  const api: ApiClient = { get, post, del };
  return { api, get, post, del };
}

describe("listApps", () => {
  describe("サーバが `{ apps: [...] }` を返すとき", () => {
    it("apps 配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      const sample: App = {
        tenantId: "t",
        appId: "a-1",
        name: "A",
        upstreamUrl: "https://x",
        status: "active",
      };
      get.mockResolvedValueOnce({ apps: [sample] });

      const res = await listApps(api);
      expect(get).toHaveBeenCalledWith("apps");
      expect(res).toEqual([sample]);
    });
  });

  describe("サーバが配列を直接返すとき", () => {
    it("その配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce([
        { tenantId: "t", appId: "a-1", name: "A", upstreamUrl: "https://x", status: "active" },
      ]);

      const res = await listApps(api);
      expect(res).toHaveLength(1);
    });
  });

  describe("サーバが `apps` なしの object を返すとき", () => {
    it("空配列を返すべき", async () => {
      const { api, get } = buildApiMock();
      get.mockResolvedValueOnce({});

      expect(await listApps(api)).toEqual([]);
    });
  });
});

describe("createApp", () => {
  it("POST /apps に name と upstreamUrl を送るべき", async () => {
    const { api, post } = buildApiMock();
    const created: App = {
      tenantId: "t",
      appId: "a-2",
      name: "新規",
      upstreamUrl: "https://new.example.com",
      status: "active",
      functionUrl: "https://xyz.lambda-url.ap-northeast-1.on.aws/",
    };
    post.mockResolvedValueOnce(created);

    const res = await createApp(api, {
      name: "新規",
      upstreamUrl: "https://new.example.com",
      allowedEmailDomains: ["example.com"],
    });

    expect(post).toHaveBeenCalledWith("apps", {
      name: "新規",
      upstreamUrl: "https://new.example.com",
      allowedEmailDomains: ["example.com"],
    });
    expect(res).toEqual(created);
  });

  it("guestEmails が指定されたら POST body に含めるべき", async () => {
    const { api, post } = buildApiMock();
    const created: App = {
      tenantId: "t",
      appId: "a-3",
      name: "guest-app",
      upstreamUrl: "https://guest.example.com",
      status: "active",
      authProvider: "Cognito",
    };
    post.mockResolvedValueOnce(created);

    await createApp(api, {
      name: "guest-app",
      upstreamUrl: "https://guest.example.com",
      allowedEmailDomains: ["example.com"],
      guestEmails: ["guest@example.com"],
    });

    expect(post).toHaveBeenCalledWith("apps", {
      name: "guest-app",
      upstreamUrl: "https://guest.example.com",
      allowedEmailDomains: ["example.com"],
      guestEmails: ["guest@example.com"],
    });
  });
});

describe("deleteApp", () => {
  it("`apps/<id>` パスに URL エンコードして DELETE を送るべき", async () => {
    const { api, del } = buildApiMock();
    del.mockResolvedValueOnce(undefined);

    await deleteApp(api, "app id with space");

    expect(del).toHaveBeenCalledWith("apps/app%20id%20with%20space");
  });
});
