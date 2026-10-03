import { describe, expect, it, vi } from "vitest";
import { createAzureDeploymentStacksRestClient } from "../../lib/problem-deploy/runtime-clients/azure-deployment-stacks-rest-client.js";

/**
 * [#1410 / #2743] ARM Deployment Stacks REST client の wire 整形を pin。 fetch を mock し、
 * endpoint / Bearer auth / ARM body (inline template / templateLink + parameters{value} +
 * actionOnUnmanage) / provisioningState+direct outputs 射影 / 404→undefined / idempotent delete /
 * 非2xx throw / remote-URI fail-closed guard / no credential leakage を観測する。
 */

const CRED = { accessToken: "aad-token" };
const OPTS = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  baseUrl: "https://arm.test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createAzureDeploymentStacksRestClient(CRED, { ...OPTS, fetchImpl: fetchImpl as never });
}

const EXPECTED_PATH =
  "https://arm.test/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Resources/deploymentStacks/p-team?api-version=2024-03-01";

describe("azure-deployment-stacks-rest-client (#1410 #2743)", () => {
  it("should PUT a deployment stack with Bearer auth, an INLINE template, and ARM-shaped parameters", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, 200));
    const document = { $schema: "s", resources: [] };
    await client(fetchImpl).upsertStack({
      name: "p-team",
      template: { kind: "inline", document },
      parameters: { tenkacloudTeam: "team-a" },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(EXPECTED_PATH);
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer aad-token");
    const body = JSON.parse(init.body);
    expect(body.properties.template).toEqual(document);
    expect(body.properties.templateLink).toBeUndefined();
    expect(body.properties.parameters).toEqual({ tenkacloudTeam: { value: "team-a" } });
    expect(body.properties.actionOnUnmanage.resources).toBe("delete");
  });

  it("should still PUT a REMOTE templateLink when the URI is a reachable https:// URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, 200));
    await client(fetchImpl).upsertStack({
      name: "p-team",
      template: { kind: "remote", uri: "https://blob.test/main.json" },
      parameters: { tenkacloudTeam: "team-a" },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.properties.templateLink.uri).toBe("https://blob.test/main.json");
    expect(body.properties.template).toBeUndefined();
  });

  it.each([
    ["a repo-relative path", "main.bicep"],
    ["a repo-relative path with a directory", "targets/azure.bicep"],
    ["a plain http URL", "http://blob.test/main.json"],
    ["a non-URL string", "not a url"],
  ])("should reject a REMOTE template URI that is %s, BEFORE any fetch", async (_label, uri) => {
    const fetchImpl = vi.fn();
    await expect(
      client(fetchImpl).upsertStack({
        name: "p-team",
        template: { kind: "remote", uri },
        parameters: {},
      }),
    ).rejects.toThrow(/must be an absolute https:\/\/ URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should GET provisioningState and flatten direct Deployment Stacks outputs", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        properties: {
          provisioningState: "succeeded",
          outputs: {
            baseUrl: "https://app.test",
            replicas: 2,
            enabled: true,
            config: { nested: "value" },
            nullable: null,
          },
        },
      }),
    );
    const state = await client(fetchImpl).getStack("p-team");
    expect(state).toEqual({
      provisioningState: "succeeded",
      outputs: {
        baseUrl: "https://app.test",
        replicas: "2",
        enabled: "true",
        config: '{"nested":"value"}',
        nullable: "",
      },
    });
  });

  it("should return undefined from getStack on 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await client(fetchImpl).getStack("p-team")).toBeUndefined();
  });

  it("should omit outputs when the stack has none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ properties: { provisioningState: "deploying" } }));
    expect(await client(fetchImpl).getStack("p")).toEqual({ provisioningState: "deploying" });
  });

  it("should DELETE the stack and treat 404 as idempotent success", async () => {
    const ok = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    await client(ok).deleteStack("p-team");
    expect(ok.mock.calls[0][1].method).toBe("DELETE");
    const gone = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client(gone).deleteStack("p-team")).resolves.toBeUndefined();
  });

  it("should throw with the status on a non-2xx PUT/GET/DELETE", async () => {
    const put = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 }));
    await expect(
      client(put).upsertStack({
        name: "p",
        template: { kind: "inline", document: {} },
        parameters: {},
      }),
    ).rejects.toThrow(/400/);
    const get = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(client(get).getStack("p")).rejects.toThrow(/500/);
    const del = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(client(del).deleteStack("p")).rejects.toThrow(/503/);
  });

  it("should never leak the Bearer token (credential) into a thrown error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("access denied", { status: 401 }));
    let caught: Error | undefined;
    try {
      await client(fetchImpl).upsertStack({
        name: "p",
        template: { kind: "inline", document: {} },
        parameters: {},
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/401/);
    expect(caught?.message).not.toContain(CRED.accessToken);
  });

  it("should reject an unreachable remote URI BEFORE any fetch, without leaking the credential", async () => {
    const fetchImpl = vi.fn();
    let caught: Error | undefined;
    try {
      await client(fetchImpl).upsertStack({
        name: "p",
        template: { kind: "remote", uri: "ftp://blob.test/main.json" },
        parameters: {},
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain(CRED.accessToken);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
