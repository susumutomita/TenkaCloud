import { describe, expect, it, vi } from "vitest";
import { createAzureEntraTokenClient } from "../../lib/problem-deploy/runtime-clients/azure-entra-token-client.js";

/**
 * [#1410] Entra ID client_credentials token client の wire を pin。 fetch を mock し、
 * token endpoint / form body (grant_type / client_id / client_secret / scope) / access_token 抽出 /
 * 非2xx throw / access_token 欠落 throw を観測する。
 */

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createAzureEntraTokenClient({
    authority: "https://login.test",
    fetchImpl: fetchImpl as never,
  });
}

const INPUT = { azureTenantId: "dir-1", clientId: "app-1", clientSecret: "shh" };

describe("azure-entra-token-client (#1410)", () => {
  it("should POST client_credentials to the tenant token endpoint and return the access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "arm-token", token_type: "Bearer", expires_in: 3600 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const token = await client(fetchImpl).getToken(INPUT);
    expect(token).toBe("arm-token");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://login.test/dir-1/oauth2/v2.0/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("app-1");
    expect(params.get("client_secret")).toBe("shh");
    expect(params.get("scope")).toBe("https://management.azure.com/.default");
  });

  it("should use a custom scope when provided", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }));
    await client(fetchImpl).getToken({ ...INPUT, scope: "https://graph.microsoft.com/.default" });
    const params = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(params.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("should throw with the status on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("invalid_client", { status: 401 }));
    await expect(client(fetchImpl).getToken(INPUT)).rejects.toThrow(/401/);
  });

  it("should throw when the response has no access_token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
      );
    await expect(client(fetchImpl).getToken(INPUT)).rejects.toThrow(/missing access_token/);
  });
});
