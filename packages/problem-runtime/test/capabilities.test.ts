import { describe, expect, it } from "vitest";
import {
  ADAPTER_WIRED_RUNTIMES,
  findRuntimeCapability,
  RUNTIME_CAPABILITIES,
  type RuntimeCapabilityDeclaration,
  runtimeCapabilityKey,
  validateRuntimeCapabilityEvidence,
} from "../src/capabilities.js";

const VALID_FIXTURE: RuntimeCapabilityDeclaration = {
  provider: "test",
  engine: "engine",
  recognized: true,
  adapterWired: true,
  executable: true,
  liveVerified: false,
  executionMode: "cloud",
  selection: "feature-gated",
  maturity: "preview",
  blockingIssues: [],
  evidence: "test fixture",
};

describe("runtime capability evidence (#2748)", () => {
  it("should keep every declaration internally consistent", () => {
    for (const capability of RUNTIME_CAPABILITIES) {
      expect(
        validateRuntimeCapabilityEvidence(capability),
        runtimeCapabilityKey(capability),
      ).toEqual([]);
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
      blockingIssues: [2081],
    });

    const gcp = findRuntimeCapability("gcp", "infra-manager");
    expect(gcp).toMatchObject({
      recognized: true,
      adapterWired: true,
      executable: false,
      liveVerified: false,
      blockingIssues: [2081],
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

  it("should expose only declarations whose adapters are wired", () => {
    expect(ADAPTER_WIRED_RUNTIMES).toEqual(RUNTIME_CAPABILITIES);
  });

  it("should reject adapter wiring without schema recognition", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        recognized: false,
        executable: false,
      }),
    ).toEqual(["test/engine: adapterWired requires recognized"]);
  });

  it("should reject execution without an adapter", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        adapterWired: false,
      }),
    ).toEqual(["test/engine: executable requires adapterWired"]);
  });

  it("should reject live verification without execution", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        executable: false,
        liveVerified: true,
      }),
    ).toEqual(["test/engine: liveVerified requires executable"]);
  });

  it("should reject live verification while blockers remain", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        liveVerified: true,
        blockingIssues: [999],
      }),
    ).toEqual(["test/engine: liveVerified cannot retain blockingIssues"]);
  });

  it("should require local execution for local-only selection", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        selection: "local-only",
      }),
    ).toEqual(["test/engine: local-only selection requires local executionMode"]);
  });

  it("should require local-only selection for local execution", () => {
    expect(
      validateRuntimeCapabilityEvidence({
        ...VALID_FIXTURE,
        executionMode: "local",
      }),
    ).toEqual(["test/engine: local executionMode requires local-only selection"]);
  });

  it("should return undefined for an unrecognized pair", () => {
    expect(findRuntimeCapability("aws", "bicep")).toBeUndefined();
  });
});
