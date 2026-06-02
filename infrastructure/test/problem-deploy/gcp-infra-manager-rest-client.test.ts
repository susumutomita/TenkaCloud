import { describe, expect, it, vi } from "vitest";
import { createGcpInfraManagerRestClient } from "../../lib/problem-deploy/runtime-clients/gcp-infra-manager-rest-client.js";

/**
 * [ADR-027 / #1411] Infrastructure Manager REST client の wire 整形を pin。 fetch を mock し、
 * endpoint / Bearer auth / terraformBlueprint(gcsSource + inputValues{inputValue}) / create-vs-update /
 * state+outputs 射影 / 404→undefined / idempotent delete / 非2xx throw を観測する。
 */

const CRED = { accessToken: "gcp-token" };
const OPTS = {
  projectId: "proj-1",
  location: "asia-northeast1",
  baseUrl: "https://config.test/v1",
};
const PARENT = "https://config.test/v1/projects/proj-1/locations/asia-northeast1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createGcpInfraManagerRestClient(CRED, { ...OPTS, fetchImpl: fetchImpl as never });
}

describe("gcp-infra-manager-rest-client (ADR-027 #1411)", () => {
  it("should POST a new deployment with ?deploymentId and a terraformBlueprint when none exists", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 })) // get → 404
      .mockResolvedValueOnce(jsonResponse({ name: "op" })); // create LRO
    await client(fetchImpl).upsertDeployment({
      name: "p-team",
      blueprintRef: "gs://bucket/config",
      inputs: { team: "team-a" },
    });
    const [createUrl, createInit] = fetchImpl.mock.calls[1];
    expect(createUrl).toBe(`${PARENT}/deployments?deploymentId=p-team`);
    expect(createInit.method).toBe("POST");
    expect(createInit.headers.Authorization).toBe("Bearer gcp-token");
    const body = JSON.parse(createInit.body);
    expect(body.terraformBlueprint.gcsSource).toBe("gs://bucket/config");
    expect(body.terraformBlueprint.inputValues).toEqual({ team: { inputValue: "team-a" } });
  });

  it("should PATCH an existing deployment (idempotent upsert)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "ACTIVE" })) // get → exists
      .mockResolvedValueOnce(jsonResponse({ name: "op" }));
    await client(fetchImpl).upsertDeployment({
      name: "p-team",
      blueprintRef: "gs://b/c",
      inputs: {},
    });
    const [updateUrl, updateInit] = fetchImpl.mock.calls[1];
    expect(updateUrl).toBe(`${PARENT}/deployments/p-team`);
    expect(updateInit.method).toBe("PATCH");
  });

  it("should GET state and flatten outputs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ state: "ACTIVE", outputs: { url: { value: "https://x.run.app" } } }),
      );
    expect(await client(fetchImpl).getDeployment("p-team")).toEqual({
      state: "ACTIVE",
      outputs: { url: "https://x.run.app" },
    });
  });

  it("should return undefined from getDeployment on 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect(await client(fetchImpl).getDeployment("p")).toBeUndefined();
  });

  it("should DELETE the deployment and treat 404 as idempotent success", async () => {
    const ok = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    await client(ok).deleteDeployment("p-team");
    expect(ok.mock.calls[0][0]).toBe(`${PARENT}/deployments/p-team`);
    expect(ok.mock.calls[0][1].method).toBe("DELETE");
    const gone = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client(gone).deleteDeployment("p")).resolves.toBeUndefined();
  });

  it("should throw with the status on a non-2xx get/create", async () => {
    const get = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(client(get).getDeployment("p")).rejects.toThrow(/500/);
  });
});
