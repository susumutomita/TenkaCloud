import { describe, expect, it } from "vitest";
import { LOCAL_API_BASE_URL, listApiOperations, OPENAPI_ARTIFACT } from "./openapi";

describe("OpenAPI artifact security", () => {
  it("uses a relative local API with no external sandbox", () => {
    expect(OPENAPI_ARTIFACT.servers).toHaveLength(1);
    expect(OPENAPI_ARTIFACT.servers[0]?.url).toBe(LOCAL_API_BASE_URL);
    expect(LOCAL_API_BASE_URL).toBe("/api");
  });

  it("should not embed any API key, bearer token, or credential in the artifact", () => {
    const serialized = JSON.stringify(OPENAPI_ARTIFACT);
    expect(serialized).not.toMatch(/Bearer [A-Za-z0-9._-]{16,}/u);
    expect(serialized).not.toMatch(/"(?:example|default)":"[^"\s]+"/u);
    expect(OPENAPI_ARTIFACT.paths["/host/login"]?.post?.security).toEqual([]);
    expect(OPENAPI_ARTIFACT.paths["/events"]?.post?.security).toEqual([{ hostSession: [] }]);
    expect(OPENAPI_ARTIFACT.paths["/portal/me"]?.get?.security).toEqual([{ teamKey: [] }]);
  });

  it("should label every operation with exactly one capability", () => {
    for (const op of listApiOperations()) {
      expect(["browse-only", "sandbox-safe", "authenticated-write"]).toContain(op.capability);
    }
  });

  it("should mark write operations as authenticated-write, not browse-only", () => {
    const createDeployment = listApiOperations().find((op) => op.operationId === "prepareEvent");
    expect(createDeployment?.capability).toBe("authenticated-write");
  });
});
