import { describe, expect, it } from "vitest";
import { buildAuditRecord } from "../src/audit.js";
import { brandVerified, type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function makeIntent(): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-audit-1",
    nonce: "nonce-audit-1",
    source: {
      system: "tenkacloud",
      tenantId: "tenant-a",
      eventId: "event-001",
      teamId: "team-alpha",
      problemId: "hello-world",
      deploymentId: "deploy-9",
      workloadId: "deploy-worker",
    },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cfn:CreateStack"],
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T22:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
  };
}

describe("buildAuditRecord (#795 Phase 1)", () => {
  const fixedNow = () => new Date("2026-05-15T19:30:00.000Z");

  it("verify 成功 + override 無しなら decision=allow で intent の domain field を埋めるべき", () => {
    const intent = makeIntent();
    const record = buildAuditRecord({
      outcome: { ok: true, intent: brandVerified(intent) },
      issuedCredentialExpiresAt: "2026-05-15T19:45:00.000Z",
      policyVersion: "policy-v1",
      now: fixedNow,
    });
    expect(record).toEqual({
      requestId: "req-audit-1",
      tenantId: "tenant-a",
      eventId: "event-001",
      teamId: "team-alpha",
      problemId: "hello-world",
      deploymentId: "deploy-9",
      provider: "aws",
      action: "deploy",
      decision: "allow",
      issuedCredentialExpiresAt: "2026-05-15T19:45:00.000Z",
      policyVersion: "policy-v1",
      createdAt: "2026-05-15T19:30:00.000Z",
    });
  });

  it("override で deny を指定したら decision が deny になり denialReason も載るべき", () => {
    const intent = makeIntent();
    const record = buildAuditRecord({
      outcome: { ok: true, intent: brandVerified(intent) },
      overrideDecision: "deny",
      overrideReason: "policy:scope-too-broad",
      now: fixedNow,
    });
    expect(record.decision).toBe("deny");
    expect(record.denialReason).toBe("policy:scope-too-broad");
  });

  it("verify 失敗系は decision=deny + denialReason=reason で unknown を埋めるべき", () => {
    const record = buildAuditRecord({
      outcome: { ok: false, reason: "expired" },
      now: fixedNow,
    });
    expect(record).toEqual({
      requestId: "unknown",
      tenantId: "unknown",
      provider: "unknown",
      action: "unknown",
      decision: "deny",
      denialReason: "expired",
      createdAt: "2026-05-15T19:30:00.000Z",
    });
  });

  it("schema 無効系も deny + denialReason=schema-invalid で audit に残るべき", () => {
    const record = buildAuditRecord({
      outcome: { ok: false, reason: "schema-invalid", details: ["constraints.ttlSeconds"] },
      now: fixedNow,
    });
    expect(record.decision).toBe("deny");
    expect(record.denialReason).toBe("schema-invalid");
  });

  it("source の optional field が無い intent では audit にも入らないべき (= clean serialization)", () => {
    const intent = makeIntent();
    const lean: CloudActionIntent = {
      ...intent,
      source: { system: "tenkacloud", tenantId: "t-2", workloadId: "w-2" },
    };
    const record = buildAuditRecord({
      outcome: { ok: true, intent: brandVerified(lean) },
      now: fixedNow,
    });
    expect(record).toEqual({
      requestId: "req-audit-1",
      tenantId: "t-2",
      provider: "aws",
      action: "deploy",
      decision: "allow",
      createdAt: "2026-05-15T19:30:00.000Z",
    });
  });
});
