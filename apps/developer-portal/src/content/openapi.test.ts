import { describe, expect, it } from "vitest";
import { listApiOperations, OPENAPI_ARTIFACT, SANDBOX_BASE_URL } from "./openapi";

describe("OpenAPI artifact security", () => {
  it("should default to the sandbox base URL and never to production", () => {
    expect(OPENAPI_ARTIFACT.servers).toHaveLength(1);
    expect(OPENAPI_ARTIFACT.servers[0]?.url).toBe(SANDBOX_BASE_URL);
    expect(SANDBOX_BASE_URL).toContain("sandbox");
  });

  it("should not embed any API key, bearer token, or credential in the artifact", () => {
    const serialized = JSON.stringify(OPENAPI_ARTIFACT).toLowerCase();
    for (const forbidden of [
      "bearer ",
      "apikey",
      "api_key",
      "authorization",
      "secret",
      "password",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("should label every operation with exactly one capability", () => {
    for (const op of listApiOperations()) {
      expect(["browse-only", "sandbox-safe", "authenticated-write"]).toContain(op.capability);
    }
  });

  it("should mark write operations as authenticated-write, not browse-only", () => {
    const createDeployment = listApiOperations().find(
      (op) => op.operationId === "createDeployment",
    );
    expect(createDeployment?.capability).toBe("authenticated-write");
  });
});
