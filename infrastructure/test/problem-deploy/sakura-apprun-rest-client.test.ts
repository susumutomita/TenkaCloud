import { describe, expect, it, vi } from "vitest";
import { createSakuraAppRunRestClient } from "../../lib/problem-deploy/runtime-clients/sakura-apprun-rest-client.js";

/**
 * [ADR-026 / #1412] AppRun REST client の wire 整形を pin。 fetch を mock し、 endpoint / Basic auth /
 * body 整形 / name↔id 解決 / status+public_url 射影 / idempotent delete / 非2xx throw を観測する。
 * 実 API の field 名差は integration 相で吸収する前提 (= waterfall)。
 */

const CRED = { accessToken: "tok", accessTokenSecret: "sec" };
const BASE = "https://example.test/apprun/api";
const EXPECTED_AUTH = `Basic ${Buffer.from("tok:sec").toString("base64")}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return createSakuraAppRunRestClient(CRED, { baseUrl: BASE, fetchImpl: fetchImpl as never });
}

describe("sakura-apprun-rest-client (ADR-026 #1412)", () => {
  it("should POST a new application with Basic auth and an image/env component when none exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // list → empty
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "p-team" }, 201)); // create
    await makeClient(fetchImpl).upsertApplication({
      name: "p-team",
      image: "registry.example/img:latest",
      env: { TENKACLOUD_TEAM: "team-a" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = fetchImpl.mock.calls[0];
    expect(listUrl).toBe(`${BASE}/applications`);
    expect(listInit.method).toBe("GET");
    expect(listInit.headers.Authorization).toBe(EXPECTED_AUTH);
    const [createUrl, createInit] = fetchImpl.mock.calls[1];
    expect(createUrl).toBe(`${BASE}/applications`);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(createInit.body);
    expect(body.name).toBe("p-team");
    expect(body.components[0].deploy_source.container_registry.image).toBe(
      "registry.example/img:latest",
    );
    expect(body.components[0].env).toEqual([{ key: "TENKACLOUD_TEAM", value: "team-a" }]);
    expect(body.port).toBe(8080);
  });

  it("should PUT to the resolved id when an application with the same name already exists (idempotent deploy)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-9", name: "p-team" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "app-9", name: "p-team" }));
    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "img:2", env: {} });
    const [updateUrl, updateInit] = fetchImpl.mock.calls[1];
    expect(updateUrl).toBe(`${BASE}/applications/app-9`);
    expect(updateInit.method).toBe("PUT");
  });

  it("should resolve name→id then read status + public_url for getApplication", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p-team" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "app-1",
          name: "p-team",
          status: "running",
          public_url: "https://x.apprun",
        }),
      );
    const state = await makeClient(fetchImpl).getApplication("p-team");
    expect(state).toEqual({ status: "running", publicUrl: "https://x.apprun" });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/applications/app-1`);
  });

  it("should return undefined from getApplication when the name is not in the list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "x", name: "other" }] }));
    expect(await makeClient(fetchImpl).getApplication("p-team")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no read when not found
  });

  it("should omit publicUrl when the application has no public_url yet", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "p", status: "provisioning" }));
    expect(await makeClient(fetchImpl).getApplication("p")).toEqual({ status: "provisioning" });
  });

  it("should DELETE by resolved id and treat a missing application as a no-op", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient(fetchImpl).deleteApplication("p");
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/applications/app-1`);
    expect(fetchImpl.mock.calls[1][1].method).toBe("DELETE");

    const emptyFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(makeClient(emptyFetch).deleteApplication("p")).resolves.toBeUndefined();
    expect(emptyFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw with the status + body on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(
      makeClient(fetchImpl).upsertApplication({ name: "p", image: "img", env: {} }),
    ).rejects.toThrow(/429/);
  });

  it("should default to the production AppRun base URL when none is provided", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const client = createSakuraAppRunRestClient(CRED, { fetchImpl: fetchImpl as never });
    await client.upsertApplication({ name: "p", image: "img", env: {} });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api/applications",
    );
  });
});
