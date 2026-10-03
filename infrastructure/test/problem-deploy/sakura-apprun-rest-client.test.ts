import { describe, expect, it, vi } from "vitest";
import { createSakuraAppRunRestClient } from "../../lib/problem-deploy/runtime-clients/sakura-apprun-rest-client.js";

/**
 * Issues #1412 / #2746: current AppRun contract and lifecycle race coverage. Every provider error
 * assertion verifies the client reports method/path/status without reflecting response bodies or
 * Basic credentials.
 */

const CREDENTIAL = { accessToken: "tok", accessTokenSecret: "sec" };
const BASE_URL = "https://example.test/apprun/api";
const EXPECTED_AUTH = `Basic ${Buffer.from("tok:sec").toString("base64")}`;
const LIST_PAGE_1 = "/applications?page_num=1&page_size=100&sort_field=created_at&sort_order=asc";
const LIST_PAGE_2 = "/applications?page_num=2&page_size=100&sort_field=created_at&sort_order=asc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listResponse(data: readonly unknown[], objectTotal?: number): Response {
  return jsonResponse({
    data,
    ...(objectTotal === undefined ? {} : { meta: { object_total: objectTotal } }),
  });
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return createSakuraAppRunRestClient(CREDENTIAL, {
    baseUrl: BASE_URL,
    fetchImpl: fetchImpl as never,
  });
}

function expectSafeError(error: unknown, expected: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(expected);
  expect((error as Error).message).not.toMatch(/tok|sec|Basic|reflected-secret/);
}

describe("sakura-apprun-rest-client (#2746)", () => {
  it("should bootstrap the AppRun user only after a missing list and cache the result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ id: "user" }, 201))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([]));
    const client = makeClient(fetchImpl);

    await expect(client.getApplication("missing")).resolves.toBeUndefined();
    await expect(client.deleteApplication("missing")).resolves.toBeUndefined();

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      `${BASE_URL}${LIST_PAGE_1}`,
      `${BASE_URL}/user`,
      `${BASE_URL}/user`,
      `${BASE_URL}${LIST_PAGE_1}`,
      `${BASE_URL}${LIST_PAGE_1}`,
    ]);
    expect(fetchImpl.mock.calls[2]?.[1].method).toBe("POST");
  });

  it("should accept a concurrent user-create conflict", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(listResponse([]));

    await expect(makeClient(fetchImpl).getApplication("missing")).resolves.toBeUndefined();
  });

  it("should reject unexpected user lookup and creation outcomes", async () => {
    const lookupConflict = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(makeClient(lookupConflict).getApplication("missing")).rejects.toThrow(
      "Sakura AppRun API GET /user conflicted",
    );

    const createNotFound = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(makeClient(createNotFound).getApplication("missing")).rejects.toThrow(
      "Sakura AppRun API POST /user returned not-found",
    );
  });

  it("should reset failed user initialization so a later call can retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error(`Authorization: ${EXPECTED_AUTH}`))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([]));
    const client = makeClient(fetchImpl);

    await expect(client.getApplication("missing")).rejects.toThrow(
      "Sakura AppRun API GET /user request failed",
    );
    await expect(client.getApplication("missing")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("should POST a new application with supported resources and deterministic env ordering", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1" }, 201));

    await makeClient(fetchImpl).upsertApplication({
      name: "p-team",
      image: "registry.example/image:latest",
      env: { Z_VALUE: "z", A_VALUE: "a" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(EXPECTED_AUTH);
    const [createUrl, createInit] = fetchImpl.mock.calls[1] ?? [];
    expect(createUrl).toBe(`${BASE_URL}/applications`);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(String(createInit.body));
    expect(body).toMatchObject({
      name: "p-team",
      timeout_seconds: 60,
      port: 8080,
      min_scale: 0,
      max_scale: 1,
    });
    expect(body.components).toEqual([
      {
        name: "main",
        max_cpu: "0.5",
        max_memory: "1Gi",
        deploy_source: { container_registry: { image: "registry.example/image:latest" } },
        env: [
          { key: "A_VALUE", value: "a" },
          { key: "Z_VALUE", value: "z" },
        ],
      },
    ]);
  });

  it("should PATCH a deterministic existing id without including immutable name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        listResponse([
          { id: "app-z", name: "p-team" },
          { id: "app-a", name: "p-team" },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "app-a" }));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image:v2", env: {} });

    const [patchUrl, patchInit] = fetchImpl.mock.calls[1] ?? [];
    expect(patchUrl).toBe(`${BASE_URL}/applications/app-a`);
    expect(patchInit.method).toBe("PATCH");
    const body = JSON.parse(String(patchInit.body));
    expect(body.name).toBeUndefined();
    expect(body.all_traffic_available).toBe(true);
  });

  it("should paginate until object_total is reached", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      name: `other-${index}`,
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse(firstPage, 101))
      .mockResolvedValueOnce(listResponse([{ id: "target", name: "p-team" }], 101))
      .mockResolvedValueOnce(jsonResponse({ id: "target" }));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image", env: {} });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE_URL}${LIST_PAGE_1}`);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${BASE_URL}${LIST_PAGE_2}`);
  });

  it("should stop pagination on an empty page when total is absent", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      name: `other-${index}`,
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse(fullPage))
      .mockResolvedValueOnce(listResponse([]));

    await expect(makeClient(fetchImpl).getApplication("missing")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${BASE_URL}${LIST_PAGE_2}`);
  });

  it("should recover when PATCH loses a delete race", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "old", name: "p-team" }]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "new" }, 201));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image", env: {} });
    expect(fetchImpl.mock.calls[1]?.[1].method).toBe("PATCH");
    expect(fetchImpl.mock.calls[3]?.[1].method).toBe("POST");
  });

  it("should recover when create loses a same-name race", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(listResponse([{ id: "winner", name: "p-team" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "winner" }));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image", env: {} });
    expect(fetchImpl.mock.calls[1]?.[1].method).toBe("POST");
    expect(fetchImpl.mock.calls[3]?.[1].method).toBe("PATCH");
  });

  it("should reject PATCH conflicts and impossible POST not-found responses", async () => {
    const patchConflict = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "app", name: "p-team" }]))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(
      makeClient(patchConflict).upsertApplication({ name: "p-team", image: "image", env: {} }),
    ).rejects.toThrow("Sakura AppRun API PATCH /applications/app conflicted");

    const createNotFound = vi
      .fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      makeClient(createNotFound).upsertApplication({ name: "p-team", image: "image", env: {} }),
    ).rejects.toThrow("Sakura AppRun API POST /applications returned not-found");
  });

  it("should fail loudly when repeated create conflicts never converge", async () => {
    const fetchImpl = vi.fn();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fetchImpl
        .mockResolvedValueOnce(listResponse([]))
        .mockResolvedValueOnce(new Response(null, { status: 409 }));
    }

    await expect(
      makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image", env: {} }),
    ).rejects.toThrow("Sakura AppRun application upsert did not converge");
  });

  it("should combine public_url detail with the dedicated current status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        listResponse([
          { id: "app", name: "p-team", status: "Deploying", public_url: "https://list" },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "app", name: "p-team", public_url: "https://detail" }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "Healthy" }));

    await expect(makeClient(fetchImpl).getApplication("p-team")).resolves.toEqual({
      status: "Healthy",
      publicUrl: "https://detail",
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(`${BASE_URL}/applications/app/status`);
  });

  it("should fall back through detail, list, and unknown status values", async () => {
    const detailStatus = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "detail", name: "p-team" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "detail", name: "p-team", status: "Deploying" }))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(makeClient(detailStatus).getApplication("p-team")).resolves.toEqual({
      status: "Deploying",
    });

    const listStatus = vi
      .fn()
      .mockResolvedValueOnce(
        listResponse([
          { id: "list", name: "p-team", status: "Healthy", public_url: "https://list" },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "list", name: "p-team" }))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(makeClient(listStatus).getApplication("p-team")).resolves.toEqual({
      status: "Healthy",
      publicUrl: "https://list",
    });

    const unknown = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "unknown", name: "p-team" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "unknown", name: "p-team" }))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(makeClient(unknown).getApplication("p-team")).resolves.toEqual({
      status: "unknown",
    });
  });

  it("should return undefined for missing names and detail/status races", async () => {
    const missing = vi.fn().mockResolvedValueOnce(listResponse([]));
    await expect(makeClient(missing).getApplication("p-team")).resolves.toBeUndefined();

    const detailGone = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "app", name: "p-team" }]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(makeClient(detailGone).getApplication("p-team")).resolves.toBeUndefined();

    const statusGone = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "app", name: "p-team" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "app", name: "p-team" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(makeClient(statusGone).getApplication("p-team")).resolves.toBeUndefined();
  });

  it("should delete all exact-name duplicates and tolerate concurrent not-found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        listResponse([
          { id: "app-b", name: "p-team" },
          { id: "other", name: "other" },
          { id: "app-a", name: "p-team" },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(makeClient(fetchImpl).deleteApplication("p-team")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.slice(1).map((call) => call[0])).toEqual([
      `${BASE_URL}/applications/app-a`,
      `${BASE_URL}/applications/app-b`,
    ]);
  });

  it("should reject delete conflicts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listResponse([{ id: "app", name: "p-team" }]))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(makeClient(fetchImpl).deleteApplication("p-team")).rejects.toThrow(
      "Sakura AppRun API DELETE /applications/app conflicted",
    );
  });

  it("should sanitize non-2xx response bodies and transport errors", async () => {
    const responseFailure = vi
      .fn()
      .mockResolvedValueOnce(new Response("tok sec reflected-secret", { status: 429 }));
    try {
      await makeClient(responseFailure).getApplication("p-team");
      expect.unreachable("request should fail");
    } catch (error) {
      expectSafeError(error, `Sakura AppRun API GET ${LIST_PAGE_1} failed: 429`);
    }

    const transportFailure = vi.fn().mockRejectedValueOnce(new Error(EXPECTED_AUTH));
    try {
      await makeClient(transportFailure).getApplication("p-team");
      expect.unreachable("request should fail");
    } catch (error) {
      expectSafeError(error, `Sakura AppRun API GET ${LIST_PAGE_1} request failed`);
    }
  });

  it("should reject list conflicts and repeated not-found after bootstrap", async () => {
    const conflict = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(makeClient(conflict).getApplication("p-team")).rejects.toThrow(
      `Sakura AppRun API GET ${LIST_PAGE_1} conflicted`,
    );

    const stillMissing = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(makeClient(stillMissing).getApplication("p-team")).rejects.toThrow(
      `Sakura AppRun API GET ${LIST_PAGE_1} returned not-found`,
    );
  });

  it("should fail loudly when a required list document is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(makeClient(fetchImpl).getApplication("p-team")).rejects.toThrow(
      `Sakura AppRun API GET ${LIST_PAGE_1} returned no document`,
    );
  });

  it("should default to the production AppRun base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(listResponse([]));
    const client = createSakuraAppRunRestClient(CREDENTIAL, { fetchImpl: fetchImpl as never });
    await client.getApplication("missing");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api/applications?page_num=1&page_size=100&sort_field=created_at&sort_order=asc",
    );
  });
});
