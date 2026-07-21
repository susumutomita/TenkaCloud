import { describe, expect, it, vi } from "vitest";
import { createSakuraAppRunRestClient } from "../../lib/problem-deploy/runtime-clients/sakura-apprun-rest-client.js";

/**
 * [ADR-026 / #1412 / #2746] AppRun REST client の wire 整形を pin。 fetch を mock し、 endpoint /
 * Basic auth / current resource enums / PATCH update / detail+status endpoint / name↔id 解決 /
 * public_url 射影 / idempotent delete / 非2xx throw を観測する。
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

describe("sakura-apprun-rest-client (ADR-026 #1412 #2746)", () => {
  it("should POST a new application with Basic auth and supported component resources", async () => {
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
    expect(body.components[0].max_cpu).toBe("0.5");
    expect(body.components[0].max_memory).toBe("1Gi");
    expect(body.port).toBe(8080);
  });

  it("should PATCH the resolved id when an application with the same name already exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-9", name: "p-team" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "app-9", name: "p-team" }));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "img:2", env: {} });

    const [updateUrl, updateInit] = fetchImpl.mock.calls[1];
    expect(updateUrl).toBe(`${BASE}/applications/app-9`);
    expect(updateInit.method).toBe("PATCH");
  });

  it("should resolve name to id, read detail, and use the dedicated status endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p-team" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "app-1",
          name: "p-team",
          status: "Deploying",
          public_url: "https://x.apprun",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "Healthy" }));

    const state = await makeClient(fetchImpl).getApplication("p-team");

    expect(state).toEqual({ status: "Healthy", publicUrl: "https://x.apprun" });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/applications/app-1`);
    expect(fetchImpl.mock.calls[2][0]).toBe(`${BASE}/applications/app-1/status`);
  });

  it("should return undefined when the name is absent or disappears between reads", async () => {
    const missing = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "x", name: "other" }] }));
    expect(await makeClient(missing).getApplication("p-team")).toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(1);

    const detailGone = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p-team" }] }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await makeClient(detailGone).getApplication("p-team")).toBeUndefined();
    expect(detailGone).toHaveBeenCalledTimes(2);

    const statusGone = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p-team" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "p-team" }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await makeClient(statusGone).getApplication("p-team")).toBeUndefined();
    expect(statusGone).toHaveBeenCalledTimes(3);
  });

  it("should omit publicUrl when the application has no public_url yet", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "p", status: "Deploying" }))
      .mockResolvedValueOnce(jsonResponse({ status: "Deploying" }));

    expect(await makeClient(fetchImpl).getApplication("p")).toEqual({ status: "Deploying" });
  });

  it("should DELETE by resolved id and treat absent or concurrently deleted apps as success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient(fetchImpl).deleteApplication("p");
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/applications/app-1`);
    expect(fetchImpl.mock.calls[1][1].method).toBe("DELETE");

    const alreadyGone = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "app-1", name: "p" }] }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(makeClient(alreadyGone).deleteApplication("p")).resolves.toBeUndefined();

    const emptyFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(makeClient(emptyFetch).deleteApplication("p")).resolves.toBeUndefined();
    expect(emptyFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw with the status and body on a non-2xx response", async () => {
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
