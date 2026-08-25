import { describe, expect, it } from "vitest";
import type { SecurityHarnessDefinition } from "../src/types.js";
import { validateSecurityHarnessDefinition } from "../src/validators.js";

const VALID: SecurityHarnessDefinition = {
  version: "tenkacloud.security-harness.v1",
  target: {
    artifactDigest: "sha256:abc123",
    runtime: "container",
    build: { operationId: "build-container-image" },
    start: { operationId: "start-container" },
    readiness: { path: "/health", expectedStatus: 200, timeoutMs: 5000 },
    goldenTests: [{ id: "own-doc-a", description: "User A can fetch their own document" }],
  },
  engagement: {
    threatModelDigest: "sha256:def456",
    allowedTargetIds: ["idor-demo"],
    allowedNetworkScopes: ["target-only"],
    nonGoals: ["credential stuffing"],
  },
  witness: {
    type: "http-sequence",
    verifierId: "phase1-deterministic-verifier",
    minimumReproductions: 2,
  },
  budget: { wallClockSeconds: 300, maxToolCalls: 50 },
};

describe("validateSecurityHarnessDefinition", () => {
  it("should accept a well-formed definition", () => {
    const result = validateSecurityHarnessDefinition(VALID);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(VALID);
  });

  it("should reject a non-object", () => {
    expect(validateSecurityHarnessDefinition(null).ok).toBe(false);
    expect(validateSecurityHarnessDefinition("nope").ok).toBe(false);
  });

  it("should reject an unrecognized version string", () => {
    expect(validateSecurityHarnessDefinition({ ...VALID, version: "v2" }).ok).toBe(false);
  });

  it("should reject an unknown top-level field", () => {
    const result = validateSecurityHarnessDefinition({ ...VALID, extraField: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("extraField"))).toBe(true);
  });

  it("should reject a target digest that is not a sha256 content reference", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        target: { ...VALID.target, artifactDigest: "latest" },
      }).ok,
    ).toBe(false);
  });

  it("should reject a build command that is not a reviewed operation id (i.e. would otherwise be arbitrary shell)", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        target: { ...VALID.target, build: { operationId: "" } },
      }).ok,
    ).toBe(false);
  });

  it("should reject an empty goldenTests array — normal function must have at least one declared check", () => {
    expect(
      validateSecurityHarnessDefinition({ ...VALID, target: { ...VALID.target, goldenTests: [] } })
        .ok,
    ).toBe(false);
  });

  it("should reject minimumReproductions below 1 — zero would confirm without ever reproducing", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        witness: { ...VALID.witness, minimumReproductions: 0 },
      }).ok,
    ).toBe(false);
  });

  it("should reject a non-positive budget", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        budget: { ...VALID.budget, wallClockSeconds: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validateSecurityHarnessDefinition({ ...VALID, budget: { ...VALID.budget, maxToolCalls: -1 } })
        .ok,
    ).toBe(false);
  });

  it("should reject a threat model digest that is not content-addressed", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        engagement: { ...VALID.engagement, threatModelDigest: "v1" },
      }).ok,
    ).toBe(false);
  });
});

describe("validateSecurityHarnessDefinition: revealPolicy (Phase 3 addition)", () => {
  it("should accept a definition with no revealPolicy at all — Phase 1 definitions predate this field", () => {
    const result = validateSecurityHarnessDefinition(VALID);
    expect(result.ok).toBe(true);
    expect(result.value?.revealPolicy).toBeUndefined();
  });

  it("should accept a well-formed revealPolicy", () => {
    const result = validateSecurityHarnessDefinition({
      ...VALID,
      revealPolicy: {
        participantCanSee: ["status", "bounded-claim-notice"],
        organizerCanSee: ["status", "verdict-reasons", "witness-digests"],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("should reject a revealPolicy containing an unknown reveal field", () => {
    const result = validateSecurityHarnessDefinition({
      ...VALID,
      revealPolicy: {
        participantCanSee: ["status", "raw-exploit-payload"],
        organizerCanSee: [],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("participantCanSee"))).toBe(true);
  });

  it("should reject a revealPolicy that is not an object", () => {
    expect(validateSecurityHarnessDefinition({ ...VALID, revealPolicy: "wide-open" }).ok).toBe(
      false,
    );
  });

  it("should reject an unknown field inside revealPolicy", () => {
    const result = validateSecurityHarnessDefinition({
      ...VALID,
      revealPolicy: { participantCanSee: [], organizerCanSee: [], hiddenBackdoorField: true },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("hiddenBackdoorField"))).toBe(true);
  });

  it("should reject a revealPolicy field that is not an array", () => {
    expect(
      validateSecurityHarnessDefinition({
        ...VALID,
        revealPolicy: { participantCanSee: "status", organizerCanSee: [] },
      }).ok,
    ).toBe(false);
  });
});
