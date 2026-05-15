import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signIntent } from "../src/jws.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";
import { type NonceStore, verifyIntent } from "../src/verify.js";

function intent(overrides: Partial<CloudActionIntent["constraints"]> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-v-1",
    nonce: `nonce-${Math.random()}`,
    source: { system: "tenkacloud", tenantId: "t-1", workloadId: "w-1" },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cfn:CreateStack"],
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
      ...overrides,
    },
  };
}

describe("verifyIntent (#795 Phase 1)", () => {
  it("有効 token + future expiresAt + nonce 未使用なら ok=true でブランド型を返すべき", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.requestId).toBe("req-v-1");
    }
  });

  it("expiresAt が now より過去なら expired を返すべき", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent({ expiresAt: "2026-05-15T10:00:00.000Z" }), { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("notBefore が now より未来なら not-yet-valid を返すべき", async () => {
    const secret = randomBytes(32);
    const token = signIntent(
      intent({
        notBefore: "2026-05-15T21:00:00.000Z",
        expiresAt: "2026-05-15T22:00:00.000Z",
      }),
      { secret },
    );
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T20:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-yet-valid");
  });

  it("nonce store が replay を返すと nonce-replay を返すべき (= replay attack 防御)", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const replayStore: NonceStore = {
      recordNonce: async () => "replay",
    };
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      nonceStore: replayStore,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nonce-replay");
  });

  it("nonce store が accepted を返すと verify は通るべき", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    let recorded = 0;
    const store: NonceStore = {
      recordNonce: async () => {
        recorded += 1;
        return "accepted";
      },
    };
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      nonceStore: store,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    expect(recorded).toBe(1);
  });

  it("schema 違反な payload (= 不要 property 混入) は schema-invalid を返すべき", async () => {
    const secret = randomBytes(32);
    // 直接 invalid payload を sign したいので、 schema を bypass して任意 object を渡す。
    const badPayload = {
      ...intent(),
      somethingExtra: "boom",
    } as unknown as CloudActionIntent;
    const token = signIntent(badPayload, { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
      expect(result.details?.length).toBeGreaterThan(0);
    }
  });

  it("signature が改ざんされていたら jws-signature-mismatch を返すべき", async () => {
    const signer = randomBytes(32);
    const verifier = randomBytes(32);
    const token = signIntent(intent(), { secret: signer });
    const result = await verifyIntent(token, {
      resolveSecret: () => verifier,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-signature-mismatch");
  });
});
