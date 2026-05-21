import { describe, expect, it } from "vitest";
import {
  type CloudActionIntent,
  canonicalize,
  INTENT_VERSION,
  parseCloudActionIntent,
} from "../src/schema.js";

function validIntent(overrides: Partial<CloudActionIntent> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-001",
    nonce: "nonce-abc",
    source: {
      system: "tenkacloud",
      tenantId: "tenant-xyz",
      workloadId: "deploy-worker-lambda",
    },
    target: {
      provider: "aws",
      providerAccountRef: "123456789012",
      region: "ap-northeast-1",
    },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
    },
    constraints: {
      ttlSeconds: 900,
      expiresAt: "2026-05-15T17:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
}

describe("CloudActionIntentSchema (#795 Phase 1)", () => {
  it("should parse a valid intent successfully and return the original", () => {
    const result = parseCloudActionIntent(validIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.version).toBe(INTENT_VERSION);
      expect(result.intent.target.provider).toBe("aws");
    }
  });

  it("should reject an unknown version (= so we can discriminate a future v2)", () => {
    const bad = { ...validIntent(), version: "tenkacloud.cloud-action-intent.v2" };
    const result = parseCloudActionIntent(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("version");
    }
  });

  it("should reject a provider outside of the enum", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      target: { ...bad.target, provider: "ibm" as unknown as "aws" },
    });
    expect(result.ok).toBe(false);
  });

  it("should reject ttlSeconds of 0 or less (= forbid intents that expire instantly)", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, ttlSeconds: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it("should reject ttlSeconds greater than 3600 (= machine-enforced short-TTL principle)", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, ttlSeconds: 4000 },
    });
    expect(result.ok).toBe(false);
  });

  it("should reject expiresAt that is not in ISO datetime format", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, expiresAt: "not-a-date" },
    });
    expect(result.ok).toBe(false);
  });

  it("should reject any property outside the schema (= strict mode defends against confused deputy)", () => {
    const result = parseCloudActionIntent({
      ...validIntent(),
      somethingExtra: "should-be-rejected",
    });
    expect(result.ok).toBe(false);
  });
});

describe("canonicalize (#795 Phase 1)", () => {
  it("should canonicalize the same object literal to identical bytes regardless of key order", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("should preserve array element order (= do not destroy intentional ordering)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("should drop undefined properties (= hash stays stable across presence of optional fields)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("should preserve null (= keep the semantic difference between explicit null and undefined)", () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("should sort nested objects recursively", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 }, alpha: 1 });
    const b = canonicalize({ alpha: 1, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});
