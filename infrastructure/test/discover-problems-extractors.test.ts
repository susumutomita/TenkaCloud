import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsRuntime,
  discoverProblemsScoring,
  discoverProblemsVisibility,
} from "../lib/utils/discover-problems-catalog";

/**
 * Issue #1418: discover-problems-catalog.ts の sibling extractors (scoring / endpoints / phases /
 * visibility / disruptions) は 22.5% branch だった。 既存 test は discoverProblemsCatalog のみ。
 * 同じ temp-dir fixture pattern で 5 関数 + parsePhaseEntry / parseDisruptionEntry の全 guard を pin。
 */
let root: string;

function writeProblem(category: string, dir: string, metadata: unknown): void {
  const target = path.join(root, category, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(metadata));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "discover-extractors-"));
  // "full": every section populated (valid + invalid entries to exercise the filters).
  writeProblem("challenges", "full", {
    id: "full-prob",
    scoring: { kind: "flag", flagOutputKey: "F", points: 100 },
    visibility: "private",
    endpoints: [
      {
        slot: "frontend",
        default: { from: "cfn-output", key: "FrontendUrl", appendPath: "/health" },
        overridable: true,
        label: "FE",
        description: "d",
      },
      { slot: "bad" }, // no default → parseEndpointSlot undefined
      "not-an-object", // non-object → undefined
    ],
    phases: [
      { name: "warmup", afterMinutes: 0 }, // minimal valid (no effect/description)
      {
        name: "attack",
        afterMinutes: 30,
        effect: { scorePathOverride: "$.x", switchPlatformToDegraded: ["edge", 5, "core"] },
        description: "desc",
      },
      { name: "noAfter" }, // afterMinutes missing → undefined
      "string-phase", // non-object → undefined
      { afterMinutes: 10 }, // name missing → undefined
      { name: "e2", afterMinutes: 5, effect: "not-object" }, // effect not object → no effect
      { name: "e3", afterMinutes: 7, effect: {} }, // effect object but no scorePathOverride/switchPlatform
    ],
    disruptions: [
      { id: "d1", name: "Latency", eventDetailType: "D.L" }, // minimal valid
      {
        id: "d2",
        name: "Full",
        eventDetailType: "D.F",
        description: "x",
        defaultAfterMinutes: 5,
        operatorEditable: ["latencyMs", 7],
        parameters: { base: 1 },
        publicHint: true,
      }, // all optional present, operatorEditable non-string filtered
      { name: "noId", eventDetailType: "x" }, // id missing → undefined
      "not-an-object", // non-object → undefined
      { id: "d3", name: "Arr", eventDetailType: "D.A", parameters: [1, 2] }, // parameters array → rejected
    ],
  });
  // "bare": id only → excluded from every sibling map; non-array sections → skip branches.
  writeProblem("challenges", "bare", { id: "bare-prob" });
  // "empty": array sections present but every entry invalid → slots/phases/entries empty →
  // excluded (covers the `length > 0` exclusion branches).
  writeProblem("challenges", "empty", {
    id: "empty-prob",
    endpoints: ["invalid"],
    phases: ["invalid"],
    disruptions: ["invalid"],
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverProblemsScoring", () => {
  it("should include problems with valid scoring and exclude those without", () => {
    const out = discoverProblemsScoring(root);
    expect(out["full-prob"]).toMatchObject({ kind: "flag" });
    expect(out["bare-prob"]).toBeUndefined();
  });
});

describe("discoverProblemsEndpoints", () => {
  it("should keep valid slots, drop invalid ones, and exclude problems with none", () => {
    const out = discoverProblemsEndpoints(root);
    expect(out["full-prob"]).toHaveLength(1);
    expect(out["full-prob"]?.[0]).toMatchObject({ slot: "frontend", overridable: true });
    expect(out["bare-prob"]).toBeUndefined(); // endpoints absent → non-array skip
    expect(out["empty-prob"]).toBeUndefined(); // all slots invalid → empty → excluded
  });
});

describe("discoverProblemsPhases", () => {
  it("should keep valid phases (incl. effect filtering) and drop invalid ones", () => {
    const out = discoverProblemsPhases(root);
    expect(out["full-prob"]).toHaveLength(4); // warmup + attack + e2 + e3
    expect(out["empty-prob"]).toBeUndefined(); // all phases invalid → empty → excluded
    const attack = out["full-prob"]?.find((p) => p.name === "attack");
    expect(attack?.effect).toEqual({
      scorePathOverride: "$.x",
      switchPlatformToDegraded: ["edge", "core"], // 5 filtered out
    });
    expect(attack?.description).toBe("desc");
    // e2 has a non-object effect → no effect field.
    expect(out["full-prob"]?.find((p) => p.name === "e2")?.effect).toBeUndefined();
    expect(out["bare-prob"]).toBeUndefined();
  });
});

describe("discoverProblemsVisibility", () => {
  it("should include only private problems", () => {
    const out = discoverProblemsVisibility(root);
    expect(out["full-prob"]).toBe("private");
    expect(out["bare-prob"]).toBeUndefined();
  });
});

describe("discoverProblemsDisruptions", () => {
  it("should keep valid disruptions (with optional-field + array filters) and drop invalid", () => {
    const out = discoverProblemsDisruptions(root);
    // d1 + d2 + d3 are valid (id/name/eventDetailType all strings); noId + non-object dropped.
    expect(out["full-prob"]).toHaveLength(3);
    const d2 = out["full-prob"]?.find((d) => d.id === "d2");
    expect(d2).toMatchObject({
      description: "x",
      defaultAfterMinutes: 5,
      operatorEditable: ["latencyMs"], // 7 filtered
      parameters: { base: 1 },
      publicHint: true,
    });
    // d3 is valid but its array `parameters` is rejected → no parameters field.
    const d3 = out["full-prob"]?.find((d) => d.id === "d3");
    expect(d3).toBeDefined();
    expect(d3).not.toHaveProperty("parameters");
    expect(out["bare-prob"]).toBeUndefined();
    expect(out["empty-prob"]).toBeUndefined(); // all disruptions invalid → empty → excluded
  });
});

describe("discoverProblemsRuntime (#2054)", () => {
  it("should collect only non-aws runtimes so container problems are caught by the deploy guard", () => {
    writeProblem("challenges", "container-prob", {
      id: "container-prob",
      runtime: {
        provider: "docker",
        engine: "compose",
        entry: "local/docker-compose.yml",
        challengeEndpoints: { Web: "http://127.0.0.1:18080" },
      },
      scoring: { kind: "verify", points: 200 },
    });
    writeProblem("challenges", "aws-explicit", {
      id: "aws-explicit",
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    });
    writeProblem("challenges", "aws-legacy", { id: "aws-legacy", cfnTemplate: "template.yaml" });
    writeProblem("challenges", "malformed-runtime", {
      id: "malformed-runtime",
      runtime: { provider: "docker", engine: "compose" }, // no entry → normalizeRuntime undefined
    });

    const out = discoverProblemsRuntime(root);
    expect(out["container-prob"]).toEqual({
      provider: "docker",
      engine: "compose",
      entry: "local/docker-compose.yml",
    });
    // aws (explicit + legacy) → executable → omitted so the deploy worker uses its default path.
    expect(out["aws-explicit"]).toBeUndefined();
    expect(out["aws-legacy"]).toBeUndefined();
    // malformed runtime (no entry) → normalizeRuntime returns undefined → omitted.
    expect(out["malformed-runtime"]).toBeUndefined();
  });

  it("should preserve composite target order in catalog discovery", () => {
    writeProblem("challenges", "composite-prob", {
      id: "composite-prob",
      runtime: {
        kind: "composite",
        targets: [
          { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
          { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
          { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
          {
            id: "sakura-service",
            provider: "sakura",
            engine: "apprun",
            entry: "sakura/service.json",
          },
        ],
      },
    });

    const out = discoverProblemsRuntime(root);

    expect(out["composite-prob"]).toEqual({
      kind: "composite",
      targets: [
        { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
        { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
        { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
        {
          id: "sakura-service",
          provider: "sakura",
          engine: "apprun",
          entry: "sakura/service.json",
        },
      ],
    });
  });

  it("should surface the problemId in catalog composite validation errors", () => {
    // #2060 acceptance: validation errors must carry the problemId (+ JSON path).
    // Discovery must thread the metadata `id` into normalizeRuntime so a malformed
    // composite in the catalog points the author at the offending problem, not
    // `<unknown>`.
    writeProblem("challenges", "bad-composite", {
      id: "bad-composite",
      runtime: {
        kind: "composite",
        targets: [
          { id: "dup", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
          { id: "dup", provider: "gcp", engine: "infra-manager", entry: "b" },
        ],
      },
    });

    expect(() => discoverProblemsRuntime(root)).toThrow(/bad-composite:runtime\.targets\[1\]\.id/);
  });
});
