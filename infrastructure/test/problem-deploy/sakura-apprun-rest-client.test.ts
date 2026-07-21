import { describe, expect, it, vi } from "vitest";
import { createSakuraAppRunRestClient } from "../../lib/problem-deploy/runtime-clients/sakura-apprun-rest-client.js";

/**
 * Issues #1412 / #2746: AppRun OpenAPI wire contract. These tests pin user bootstrap, paginated
 * name→id resolution, POST/PATCH bodies, dedicated status reads, race handling, cleanup, and
 * credential-safe failures without touching a real provider account.
 */

const CREDENTIAL = { accessToken: "tok", accessTokenSecret: "sec" };
const BASE_URL = "https://example.test/apprun/api";
const EXPECTED_AUTH = `Basic ${Buffer.from("tok:sec").toString("base64")}`;
const LIST_PATH = "/applications?page_num=1&page_size=100&sort_field=created_at&sort_order=asc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listResponse(data: readonly unknown[], objectTotal = data.length): Response {
  return jsonResponse({ data, meta: { object_total: objectTotal } });
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return createSakuraAppRunRestClient(CREDENTIAL, {
    baseUrl: BASE_URL,
    fetchImpl: fetchImpl as never,
  });
}

function expectBasicAuth(fetchImpl: ReturnType<typeof vi.fn>, callIndex: number): void {
  const init = fetchImpl.mock.calls[callIndex]?.[1];
  expect(init.headers.Authorization).toBe(EXPECTED_AUTH);
}

describe("sakura-apprun-rest-client (#2746)", () => {
  it("should POST a new application with supported resources and stable env ordering", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "p-team" }, 201));

    await makeClient(fetchImpl).upsertApplication({
      name: "p-team",
      image: "registry.example/image:latest",
      env: { Z_VALUE: "z", A_VALUE: "a" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE_URL}/user`);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${BASE_URL}${LIST_PATH}`);
    expectBasicAuth(fetchImpl, 0);
    const [createUrl, createInit] = fetchImpl.mock.calls[2] ?? [];
    expect(createUrl).toBe(`${BASE_URL}/applications`);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(String(createInit.body));
    expect(body).toMatchObject({
      name: "p-team",
      port: 8080,
      min_scale: 0,
      max_scale: 1,
      timeout_seconds: 60,
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

  it("should create the AppRun user once when the account has not been initialized", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ id: "user" }, 201))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([]));
    const client = makeClient(fetchImpl);

    await expect(client.getApplication("missing")).resolves.toBeUndefined();
    await expect(client.deleteApplication("missing")).resolves.toBeUndefined();

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      `${BASE_URL}/user`,
      `${BASE_URL}/user`,
      `${BASE_URL}${LIST_PATH}`,
      `${BASE_URL}${LIST_PATH}`,
    ]);
    expect(fetchImpl.mock.calls[1]?.[1].method).toBe("POST");
  });

  it("should accept a concurrent user-create conflict as successful initialization", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(listResponse([]));

    await expect(makeClient(fetchImpl).getApplication("missing")).resolves.toBeUndefined();
  });

  it("should PATCH an existing application without name and roll traffic to the latest version", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "app-9", name: "p-team" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-9" }));

    await makeClient(fetchImpl).upsertApplication({ name: "p-team", image: "image:v2", env: {} });

    const [updateUrl, updateInit] = fetchImpl.mock.calls[2] ?? [];
    expect(updateUrl).toBe(`${BASE_URL}/applications/app-9`);
    expect(updateInit.method).toBe("PATCH");
    const body = JSON.parse(String(updateInit.body));
    expect(body.name).toBeUndefined();
    expect(body.all_traffic_available).toBe(true);
    expect(body.components[0]).toMatchObject({
      max_cpu: "0.5",
      max_memory: "1Gi",
      deploy_source: { container_registry: { image: "image:v2" } },
    });
  });

  it("should paginate all applications and select duplicate names by stable id order", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${String(index).padStart(3, "0")}`,
      name: `other-${index}`,
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse(firstPage, 102))
      .mockResolvedValueOnce(
        listResponse(
          [
            { id: "app-z", name: "target" },
            { id: "app-a", name: "target" },
          ],
          102,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "app-a" }));

    await makeClient(fetchImpl).upsertApplication({ name: "target", image: "image", env: {} });

    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      `${BASE_URL}/applications?page_num=2&page_size=100&sort_field=created_at&sort_order=asc`,
    );
    expect(fetchImpl.mock.calls[3]?.[0]).toBe(`${BASE_URL}/applications/app-a`);
  });

  it("should retry name resolution when PATCH races with application deletion", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "app-old", name: "target" }]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(listResponse([{ id: "app-new", name: "target" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-new" }));

    await makeClient(fetchImpl).upsertApplication({ name: "target", image: "image", env: {} });

    expect(fetchImpl.mock.calls[2]?.[0]).toBe(`${BASE_URL}/applications/app-old`);
    expect(fetchImpl.mock.calls[4]?.[0]).toBe(`${BASE_URL}/applications/app-new`);
  });

  it("should converge after a create conflict caused by a concurrent worker", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(listResponse([{ id: "app-race", name: "target" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-race" }));

    await makeClient(fetchImpl).upsertApplication({ name: "target", image: "image", env: {} });

    expect(fetchImpl.mock.calls[2]?.[1].method).toBe("POST");
    expect(fetchImpl.mock.calls[4]?.[1].method).toBe("PATCH");
  });

  it("should combine public_url from application detail with the dedicated fresh status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "app-1", name: "target" }]))
      .mockResolvedValueOnce(
        jsonResponse({ id: "app-1", name: "target", public_url: "https://target.apprun" }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "Healthy" }));

    await expect(makeClient(fetchImpl).getApplication("target")).resolves.toEqual({
      status: "Healthy",
      publicUrl: "https://target.apprun",
    });
    expect(fetchImpl.mock.calls[3]?.[0]).toBe(`${BASE_URL}/applications/app-1/status`);
  });

  it("should return undefined without detail reads when no exact name exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "other", name: "other" }]));

    await expect(makeClient(fetchImpl).getApplication("target")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should treat detail or status not-found races as an absent application", async () => {
    const detailRace = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "app-1", name: "target" }]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(makeClient(detailRace).getApplication("target")).resolves.toBeUndefined();
    expect(detailRace).toHaveBeenCalledTimes(3);

    const statusRace = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([{ id: "app-1", name: "target" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "app-1", name: "target" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(makeClient(statusRace).getApplication("target")).resolves.toBeUndefined();
    expect(statusRace).toHaveBeenCalledTimes(4);
  });

  it("should delete every exact-name duplicate and tolerate concurrent not-found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(
        listResponse([
          { id: "app-b", name: "target" },
          { id: "app-a", name: "target" },
          { id: "other", name: "other" },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(makeClient(fetchImpl).deleteApplication("target")).resolves.toBeUndefined();

    expect(fetchImpl.mock.calls.slice(2).map((call) => call[0])).toEqual([
      `${BASE_URL}/applications/app-a`,
      `${BASE_URL}/applications/app-b`,
    ]);
    expect(fetchImpl.mock.calls[2]?.[1].method).toBe("DELETE");
  });

  it("should make delete a no-op when the application is already absent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([]));

    await expect(makeClient(fetchImpl).deleteApplication("target")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should expose method/path/status but never response content or credentials on API failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(new Response("tok sec reflected-secret-value", { status: 429 }));

    const failure = makeClient(fetchImpl).getApplication("target");
    await expect(failure).rejects.toThrow(`Sakura AppRun API GET ${LIST_PATH} failed: 429`);
    await expect(failure).rejects.not.toThrow(/tok|sec|reflected-secret-value/);
  });

  it("should sanitize fetch exceptions that might contain request headers", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error(`Authorization: ${EXPECTED_AUTH}`));

    const failure = makeClient(fetchImpl).getApplication("target");
    await expect(failure).rejects.toThrow("Sakura AppRun API GET /user request failed");
    await expect(failure).rejects.not.toThrow(/Basic|tok|sec/);
  });

  it("should default to the production AppRun base URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user" }))
      .mockResolvedValueOnce(listResponse([]));
    const client = createSakuraAppRunRestClient(CREDENTIAL, { fetchImpl: fetchImpl as never });

    await client.getApplication("missing");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api/user",
    );
  });
});
