import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createCoreApiClient } from "../src/api-client";

describe("createCoreApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should append the path to baseUrl and attach an Authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createCoreApiClient("https://api.example.com/prod", "TOKEN");
    await api.get("tenants");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.com/prod/tenants");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
  });

  it("should append a trailing slash to baseUrl when it lacks one (already-slash kept)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createCoreApiClient("https://api.example.com/prod/", "T");
    await api.get("tenants");
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://api.example.com/prod/tenants");
  });

  it("should send POST/PUT/PATCH bodies as JSON with the right method", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const api = createCoreApiClient("https://api.example.com", "T");

    await api.post("x", { a: 1 });
    const [, postInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(postInit.method).toBe("POST");
    expect(postInit.body).toBe(JSON.stringify({ a: 1 }));

    await api.put("x", { a: 2 });
    const [, putInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(putInit.method).toBe("PUT");

    await api.patch("x", { a: 3 });
    const [, patchInit] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(patchInit.method).toBe("PATCH");
  });

  it("should issue a DELETE for del() and resolve void", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createCoreApiClient("https://api.example.com", "T");
    await expect(api.del("tenants/t-1")).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("DELETE");
  });

  it("should issue a DELETE for delJson() and resolve the JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ enqueued: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createCoreApiClient("https://api.example.com", "T");
    await expect(api.delJson("teardown")).resolves.toEqual({ enqueued: 3 });
  });

  describe("when the server returns 4xx/5xx", () => {
    it("should throw an ApiError with the response body as message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("bad", { status: 400, statusText: "Bad" })),
      );
      const api = createCoreApiClient("https://api.example.com", "T");
      await expect(api.get("x")).rejects.toBeInstanceOf(ApiError);
      await expect(api.get("x")).rejects.toMatchObject({ status: 400 });
    });

    it("should fall back to statusText when the error body cannot be read", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: () => Promise.reject(new Error("stream error")),
        } as unknown as Response),
      );
      const api = createCoreApiClient("https://api.example.com", "T");
      await expect(api.get("x")).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("Service Unavailable"),
      });
    });
  });

  describe("when fetch rejects (network error)", () => {
    it("should normalize the failure to ApiError(0) with a network-error message", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      const api = createCoreApiClient("https://api.example.com", "T");
      await expect(api.get("x")).rejects.toMatchObject({
        status: 0,
        message: expect.stringContaining("Network error: Failed to fetch"),
      });
    });
  });
});
