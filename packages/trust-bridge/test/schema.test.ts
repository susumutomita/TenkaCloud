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
  it("正常な intent は parse 成功して original を返すべき", () => {
    const result = parseCloudActionIntent(validIntent());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.version).toBe(INTENT_VERSION);
      expect(result.intent.target.provider).toBe("aws");
    }
  });

  it("未知の version は reject すべき (= 将来の v2 で discriminate するため)", () => {
    const bad = { ...validIntent(), version: "tenkacloud.cloud-action-intent.v2" };
    const result = parseCloudActionIntent(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("version");
    }
  });

  it("provider が enum 外なら reject すべき", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      target: { ...bad.target, provider: "ibm" as unknown as "aws" },
    });
    expect(result.ok).toBe(false);
  });

  it("ttlSeconds が 0 以下なら reject すべき (= 即失効 intent の禁止)", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, ttlSeconds: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it("ttlSeconds が 3600 を超えたら reject すべき (= short-TTL 原則の機械強制)", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, ttlSeconds: 4000 },
    });
    expect(result.ok).toBe(false);
  });

  it("expiresAt が ISO datetime 形式でなければ reject すべき", () => {
    const bad = validIntent();
    const result = parseCloudActionIntent({
      ...bad,
      constraints: { ...bad.constraints, expiresAt: "not-a-date" },
    });
    expect(result.ok).toBe(false);
  });

  it("schema 外の property があれば reject すべき (= strict mode で confused deputy 防御)", () => {
    const result = parseCloudActionIntent({
      ...validIntent(),
      somethingExtra: "should-be-rejected",
    });
    expect(result.ok).toBe(false);
  });
});

describe("canonicalize (#795 Phase 1)", () => {
  it("同じ object literal は順序が違っても同じ byte に正規化されるべき", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("array の要素順は preserve されるべき (= 意図的順序を破壊しない)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("undefined property は drop されるべき (= optional field の有無で hash 不変)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("null は preserve されるべき (= explicit null と undefined の意味差を保つ)", () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("nested object も再帰的に sort されるべき", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 }, alpha: 1 });
    const b = canonicalize({ alpha: 1, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});
