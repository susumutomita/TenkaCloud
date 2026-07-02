/**
 * [Problem Test Harness / Issue #2107] Required behavior suite.
 *
 * Covers the eight required cases from the issue plus the determinism / isolation
 * guarantees. All fixtures are pure data; nothing here touches a real provider.
 */

import { describe, expect, it } from "vitest";
import { runHarness, toJsonResult } from "../src/run-harness.js";
import { runTestCase } from "../src/run-test-case.js";
import type { ProblemTestCase } from "../src/types.js";

const PACK_ID = "com.example.test-pack";

function flagCase(overrides: Partial<ProblemTestCase> = {}): ProblemTestCase {
  return {
    name: "flag-ready",
    metadata: {
      id: "hello-flag",
      scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
    },
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    deployment: "ready",
    outputs: { FlagValue: "T{deterministic}" },
    expected: { valid: true, score: "success" },
    ...overrides,
  };
}

function compositeCase(overrides: Partial<ProblemTestCase> = {}): ProblemTestCase {
  return {
    name: "four-provider-composite",
    metadata: {
      id: "global-fleet",
      runtime: {
        kind: "composite",
        targets: [
          { id: "aws", provider: "aws", engine: "cloudformation", entry: "aws.yaml" },
          { id: "gcp", provider: "gcp", engine: "infra-manager", entry: "gcp.yaml" },
          { id: "azure", provider: "azure", engine: "bicep", entry: "azure.bicep" },
          { id: "sakura", provider: "sakura", engine: "apprun", entry: "sakura.yaml" },
        ],
      },
      scoring: {
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 400,
        targets: [
          { targetId: "aws", probe: "https", outputKey: "AwsUrl", expectStatus: [200] },
          { targetId: "gcp", probe: "https", outputKey: "GcpUrl", expectStatus: [200] },
          { targetId: "azure", probe: "https", outputKey: "AzureUrl", expectStatus: [200] },
          { targetId: "sakura", probe: "https", outputKey: "SakuraUrl", expectStatus: [200] },
        ],
      },
    },
    runtime: {
      kind: "composite",
      targets: [
        { id: "aws", provider: "aws", engine: "cloudformation", entry: "aws.yaml" },
        { id: "gcp", provider: "gcp", engine: "infra-manager", entry: "gcp.yaml" },
        { id: "azure", provider: "azure", engine: "bicep", entry: "azure.bicep" },
        { id: "sakura", provider: "sakura", engine: "apprun", entry: "sakura.yaml" },
      ],
    },
    deployment: "ready",
    outputs: {
      AwsUrl: "https://aws.example/",
      GcpUrl: "https://gcp.example/",
      AzureUrl: "https://azure.example/",
      SakuraUrl: "https://sakura.example/",
    },
    probeResults: {
      "https://aws.example/": { status: 200, reachable: true },
      "https://gcp.example/": { status: 200, reachable: true },
      "https://azure.example/": { status: 200, reachable: true },
      "https://sakura.example/": { status: 200, reachable: true },
    },
    expected: { valid: true, score: "success" },
    ...overrides,
  };
}

describe("local problem test harness", () => {
  it("should run a passing flag-style scoring fixture", () => {
    const result = runHarness(PACK_ID, [flagCase()]);
    expect(result.ok).toBe(true);
    expect(result.results[0].score).toBe("success");
    expect(result.results[0].passed).toBe(true);
    expect(result.results[0].packId).toBe(PACK_ID);
    expect(result.results[0].problemId).toBe("hello-flag");
  });

  it("should fail when a declared output key is absent", () => {
    const result = runTestCase(
      PACK_ID,
      flagCase({ outputs: {}, expected: { valid: true, score: "not-runnable" } }),
    );
    expect(result.score).toBe("not-runnable");
    expect(result.passed).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("SCORING_MISSING_OUTPUT_KEY");
  });

  it("should fail when a composite scoring target is not declared", () => {
    const broken = compositeCase();
    const result = runTestCase(PACK_ID, {
      ...broken,
      metadata: {
        ...broken.metadata,
        scoring: {
          kind: "composite-probe",
          success: "all",
          pointsAllOk: 400,
          targets: [
            { targetId: "ghost", probe: "https", outputKey: "AwsUrl", expectStatus: [200] },
          ],
        },
      },
      expected: { valid: true, score: "not-runnable" },
    });
    expect(result.score).toBe("not-runnable");
    expect(result.diagnostics.map((d) => d.code)).toContain("SCORING_UNDECLARED_TARGET");
  });

  it("should run a four-provider composite fake fixture", () => {
    const result = runTestCase(PACK_ID, compositeCase());
    expect(result.valid).toBe(true);
    expect(result.score).toBe("success");
    expect(result.passed).toBe(true);
  });

  it("should not access network or provider SDK", () => {
    // The harness only imports the SDK + node:fs/path. A real cloud/network call
    // would require an http/aws import; assert none are reachable from the public
    // entrypoint by exercising a probe fixture with no real endpoint available.
    const result = runTestCase(PACK_ID, compositeCase());
    // A success here means the probe was a pure map lookup, not a real request.
    expect(result.score).toBe("success");
    const fail = runTestCase(PACK_ID, {
      ...compositeCase(),
      name: "probe-failure",
      probeResults: {
        "https://aws.example/": { reachable: false },
        "https://gcp.example/": { status: 200, reachable: true },
        "https://azure.example/": { status: 200, reachable: true },
        "https://sakura.example/": { status: 200, reachable: true },
      },
      expected: { valid: true, score: "failure" },
    });
    expect(fail.score).toBe("failure");
    expect(fail.diagnostics.map((d) => d.code)).toContain("SCORING_PROBE_FAILED");
  });

  it("should return stable JSON result ordering", () => {
    const cases = [flagCase(), compositeCase()];
    const first = toJsonResult(runHarness(PACK_ID, cases));
    const second = toJsonResult(runHarness(PACK_ID, cases));
    expect(first).toBe(second);
    // Results keep declared order.
    const parsed = JSON.parse(first) as { results: { problemId: string }[] };
    expect(parsed.results.map((r) => r.problemId)).toEqual(["hello-flag", "global-fleet"]);
  });

  it("should allow a deploy-only problem without tests", () => {
    const deployOnly: ProblemTestCase = {
      name: "deploy-only",
      metadata: { id: "infra-only" },
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      deployment: "ready",
      expected: { valid: true },
    };
    const result = runTestCase(PACK_ID, deployOnly);
    expect(result.score).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("should distinguish harness failure from test assertion failure", () => {
    // An assertion failure: the actual score does not match the expectation. This
    // is reported (passed=false), NOT thrown — only the pack runner throws a
    // HarnessError for a tool error, exercised in pack-runner.test.ts.
    const result = runTestCase(PACK_ID, flagCase({ expected: { valid: true, score: "failure" } }));
    expect(result.passed).toBe(false);
    expect(result.score).toBe("success");
  });

  it("should not run the scorer when the deployment fixture is 'failed'", () => {
    const result = runTestCase(
      PACK_ID,
      flagCase({
        deployment: "failed",
        expected: { valid: true, score: "not-runnable", diagnostics: ["SCORING_DEPLOY_FAILED"] },
      }),
    );
    expect(result.score).toBe("not-runnable");
    expect(result.passed).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("SCORING_DEPLOY_FAILED");
  });

  it("should pass when every expected diagnostic code is present", () => {
    const result = runTestCase(
      PACK_ID,
      flagCase({
        outputs: {},
        expected: {
          valid: true,
          score: "not-runnable",
          diagnostics: ["SCORING_MISSING_OUTPUT_KEY"],
        },
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("should not run the scorer when the scoring kind is outside the known union", () => {
    // narrowScoring returns undefined for an unrecognized kind, so no score is set
    // (the case is treated as deploy-only for scoring purposes).
    const result = runTestCase(PACK_ID, {
      name: "unknown-kind",
      metadata: { id: "x", scoring: { kind: "mystery-kind" } } as never,
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      deployment: "ready",
      expected: { valid: false },
    });
    expect(result.score).toBeUndefined();
  });

  it("should default missing outputs to an empty map when scoring runs", () => {
    // A scoring case that omits `outputs` entirely must still run the scorer against
    // an empty output map (→ not-runnable), never crash on undefined.
    const result = runTestCase(PACK_ID, {
      name: "no-outputs",
      metadata: {
        id: "hello-flag",
        scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
      },
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      deployment: "ready",
      expected: { valid: true, score: "not-runnable" },
    });
    expect(result.score).toBe("not-runnable");
    expect(result.passed).toBe(true);
  });

  it("should report SDK validation diagnostics and stable-sort them alongside scorer diagnostics", () => {
    // Invalid metadata (missing flagOutputKey) yields a validation diagnostic; the
    // scorer then also raises a missing-output diagnostic, so the result carries two
    // and exercises the stable diagnostic sort.
    const result = runTestCase(PACK_ID, {
      name: "invalid-flag",
      metadata: { id: "broken", scoring: { kind: "flag" } } as never,
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      deployment: "ready",
      outputs: {},
      expected: { valid: false },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
    // Stable sort: paths are non-decreasing.
    const paths = result.diagnostics.map((d) => d.path);
    expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
  });

  it("should fail when an expected diagnostic code is absent from the actuals", () => {
    // The fixture scores cleanly (success, no diagnostics), so an author asserting
    // a diagnostic code that never fires must see passed=false.
    const result = runTestCase(
      PACK_ID,
      flagCase({
        expected: { valid: true, score: "success", diagnostics: ["SCORING_MISSING_OUTPUT_KEY"] },
      }),
    );
    expect(result.passed).toBe(false);
  });
});
