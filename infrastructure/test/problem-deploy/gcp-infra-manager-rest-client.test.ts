import { describe, expect, it, vi } from "vitest";
import { createGcpInfraManagerRestClient } from "../../lib/problem-deploy/runtime-clients/gcp-infra-manager-rest-client.js";

/**
 * [#1411 / #2745] Infrastructure Manager REST client の wire 整形を pin。 fetch を mock し、
 * endpoint / Bearer auth / required serviceAccount / materialized GCS source / create-vs-update mask /
 * latest Revision の outputs 射影 / 404→undefined / idempotent delete / 非2xx throw を観測する。
 */

const CRED = { accessToken: "gcp-token" };
const OPTS = {
  projectId: "proj-1",
  serviceAccountEmail: "tenkacloud@proj-1.iam.gserviceaccount.com",
  location: "asia-northeast1",
  baseUrl: "https://config.test/v1",
};
const RESOURCE_PARENT = "projects/proj-1/locations/asia-northeast1";
const PARENT = `https://config.test/v1/${RESOURCE_PARENT}`;
const REVISION = `${RESOURCE_PARENT}/deployments/p-team/revisions/rev-1`;
const SERVICE_ACCOUNT = "projects/proj-1/serviceAccounts/tenkacloud@proj-1.iam.gserviceaccount.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createGcpInfraManagerRestClient(CRED, { ...OPTS, fetchImpl: fetchImpl as never });
}

describe("gcp-infra-manager-rest-client (#1411 #2745)", () => {
  it("should POST a new deployment with a GCS blueprint and required service account", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 })) // get → 404
      .mockResolvedValueOnce(jsonResponse({ name: "op" })); // create LRO

    await client(fetchImpl).upsertDeployment({
      name: "p-team",
      blueprintRef: "gs://bucket/config.zip#123",
      inputs: { team: "team-a" },
    });

    const [createUrl, createInit] = fetchImpl.mock.calls[1];
    expect(createUrl).toBe(`${PARENT}/deployments?deploymentId=p-team`);
    expect(createInit.method).toBe("POST");
    expect(createInit.headers.Authorization).toBe("Bearer gcp-token");
    const body = JSON.parse(createInit.body);
    expect(body.serviceAccount).toBe(SERVICE_ACCOUNT);
    expect(body.terraformBlueprint.gcsSource).toBe("gs://bucket/config.zip#123");
    expect(body.terraformBlueprint.inputValues).toEqual({ team: { inputValue: "team-a" } });
  });

  it("should reject an unmaterialized repository-relative blueprint before any provider call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      client(fetchImpl).upsertDeployment({
        name: "p-team",
        blueprintRef: "gcp/terraform",
        inputs: {},
      }),
    ).rejects.toThrow(/materialized gs:\/\//);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should PATCH an existing deployment with an explicit update mask", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "ACTIVE" })) // get → exists
      .mockResolvedValueOnce(jsonResponse({ name: "op" }));

    await client(fetchImpl).upsertDeployment({
      name: "p-team",
      blueprintRef: "gs://bucket/config.zip",
      inputs: {},
    });

    const [updateUrl, updateInit] = fetchImpl.mock.calls[1];
    expect(updateUrl).toBe(
      `${PARENT}/deployments/p-team?updateMask=terraformBlueprint%2CserviceAccount`,
    );
    expect(updateInit.method).toBe("PATCH");
    const body = JSON.parse(updateInit.body);
    expect(body.name).toBe(`${RESOURCE_PARENT}/deployments/p-team`);
    expect(body.serviceAccount).toBe(SERVICE_ACCOUNT);
  });

  it("should GET state and flatten outputs from latestRevision.applyResults", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "ACTIVE", latestRevision: REVISION }))
      .mockResolvedValueOnce(
        jsonResponse({
          applyResults: {
            outputs: {
              url: { value: "https://x.run.app" },
              replicas: { value: 2 },
              enabled: { value: true },
              config: { value: { nested: "value" } },
              nullable: { value: null },
              secret: { value: "do-not-persist", sensitive: true },
            },
          },
        }),
      );

    expect(await client(fetchImpl).getDeployment("p-team")).toEqual({
      state: "ACTIVE",
      outputs: {
        url: "https://x.run.app",
        replicas: "2",
        enabled: "true",
        config: '{"nested":"value"}',
        nullable: "",
      },
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://config.test/v1/${REVISION}`);
  });

  it("should return state without reading outputs until a latest active revision exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        state: "UPDATING",
        latestRevision: REVISION,
      }),
    );
    expect(await client(fetchImpl).getDeployment("p-team")).toEqual({ state: "UPDATING" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should reject a latestRevision outside the requested deployment boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        state: "ACTIVE",
        latestRevision: `${RESOURCE_PARENT}/deployments/other/revisions/rev-1`,
      }),
    );
    await expect(client(fetchImpl).getDeployment("p-team")).rejects.toThrow(
      /outside deployment 'p-team'/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("should throw with the status on a non-2xx deployment or revision read", async () => {
    const get = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(client(get).getDeployment("p")).rejects.toThrow(/500/);

    const revision = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ state: "ACTIVE", latestRevision: REVISION }))
      .mockResolvedValueOnce(new Response("revision failed", { status: 503 }));
    await expect(client(revision).getDeployment("p-team")).rejects.toThrow(/503/);
  });
});
