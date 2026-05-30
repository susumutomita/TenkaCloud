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

  it("should set decision=allow and populate domain fields from the intent on verify success without override", () => {
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

  it("should default createdAt to the current time and include targetId when the source has one", () => {
    const base = makeIntent();
    const intent = brandVerified({ ...base, source: { ...base.source, targetId: "target-7" } });
    const record = buildAuditRecord({
      outcome: { ok: true, intent },
      issuedCredentialExpiresAt: "2026-05-15T19:45:00.000Z",
      // `now` omitted on purpose → exercises the `() => new Date()` default.
    });
    expect(record.decision).toBe("allow");
    expect(record.targetId).toBe("target-7");
    expect(typeof record.createdAt).toBe("string");
  });

  it("should set decision to deny and include denialReason when override specifies deny", () => {
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

  it("should record verify failures as decision=deny + denialReason=reason and fill missing fields with unknown", () => {
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

  it("should also record schema-invalid cases as deny + denialReason=schema-invalid in audit", () => {
    const record = buildAuditRecord({
      outcome: { ok: false, reason: "schema-invalid", details: ["constraints.ttlSeconds"] },
      now: fixedNow,
    });
    expect(record.decision).toBe("deny");
    expect(record.denialReason).toBe("schema-invalid");
  });

  it("should omit source optional fields from audit when the intent lacks them (= clean serialization)", () => {
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
