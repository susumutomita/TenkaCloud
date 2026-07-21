import { describe, expect, it } from "vitest";
import {
  findRuntimeCapability,
  RUNTIME_CAPABILITIES,
  runtimeCapabilityKey,
  validateRuntimeCapabilityEvidence,
} from "../src/capabilities.js";

describe("runtime capability evidence (#2748)", () => {
  it("should keep every declaration internally consistent", () => {
    for (const capability of RUNTIME_CAPABILITIES) {
      expect(validateRuntimeCapabilityEvidence(capability), runtimeCapabilityKey(capability)).toEqual(
        [],
      );
    }
  });

  it("should declare each provider/engine pair exactly once", () => {
    const keys = RUNTIME_CAPABILITIES.map(runtimeCapabilityKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("should distinguish schema recognition, adapter wiring, execution, and live verification", () => {
    const azure = findRuntimeCapability("azure", "bicep");
    expect(azure).toMatchObject({
      recognized: true,
      adapterWired: true,
      executable: false,
      liveVerified: false,
      blockingIssues: [2743, 2081],
    });

    const gcp = findRuntimeCapability("gcp", "infra-manager");
    expect(gcp).toMatchObject({
      recognized: true,
      adapterWired: true,
      executable: false,
      liveVerified: false,
      blockingIssues: [2745, 2081],
    });

    const sakura = findRuntimeCapability("sakura", "apprun");
    expect(sakura).toMatchObject({
      recognized: true,
      adapterWired: true,
      executable: true,
      liveVerified: false,
      blockingIssues: [2081],
    });
  });

  it("should identify AWS and local container execution independently", () => {
    expect(findRuntimeCapability("aws", "cloudformation")).toMatchObject({
      executionMode: "cloud",
      selection: "default",
      executable: true,
      liveVerified: true,
      maturity: "stable",
    });
    expect(findRuntimeCapability("docker", "compose")).toMatchObject({
      executionMode: "local",
      selection: "local-only",
      executable: true,
      liveVerified: true,
      maturity: "preview",
    });
  });

  it("should reject unsupported evidence promotions", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        provider: "test",
        engine: "adapterless",
        recognized: true,
        adapterWired: false,
        executable: true,
        liveVerified: true,
        executionMode: "cloud",
        selection: "feature-gated",
        maturity: "preview",
        blockingIssues: [999],
        evidence: "invalid fixture",
      }),
    ).toEqual([
      "test/adapterless: executable requires adapterWired",
      "test/adapterless: liveVerified cannot retain blockingIssues",
    ]);
  });

  it("should return undefined for an unrecognized pair", () => {
    expect(findRuntimeCapability("aws", "bicep")).toBeUndefined();
  });
});
