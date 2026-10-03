import { describe, expect, it } from "vitest";
import {
  asCompositeDescriptor,
  makeProblemRuntimeDescriptorResolver,
  makeProblemRuntimeResolver,
  parseProblemRuntimeDescriptors,
  parseProblemRuntimes,
} from "../../lib/problem-deploy/handlers/shared/runtime/runtime-catalog-env.js";

const CONTAINER = { provider: "docker", engine: "compose", entry: "local/docker-compose.yml" };

const COMPOSITE = {
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://bucket/worker" },
  ],
};

describe("parseProblemRuntimes (#2054)", () => {
  it("should decode a baked runtime catalog", () => {
    expect(parseProblemRuntimes(JSON.stringify({ "sqli-demo": CONTAINER }))).toEqual({
      "sqli-demo": CONTAINER,
    });
  });

  it("should return an empty map for unset / empty env", () => {
    expect(parseProblemRuntimes(undefined)).toEqual({});
    expect(parseProblemRuntimes("")).toEqual({});
  });

  it("should fail safe (empty) on malformed JSON or non-object payloads", () => {
    expect(parseProblemRuntimes("{not json")).toEqual({});
    expect(parseProblemRuntimes("[]")).toEqual({});
    expect(parseProblemRuntimes("null")).toEqual({});
  });

  it("should drop entries missing provider/engine/entry", () => {
    const raw = JSON.stringify({
      ok: CONTAINER,
      noEntry: { provider: "docker", engine: "compose" },
      notObject: "x",
    });
    expect(parseProblemRuntimes(raw)).toEqual({ ok: CONTAINER });
  });
});

describe("makeProblemRuntimeResolver", () => {
  it("should resolve a container problem's runtime and undefined otherwise", () => {
    const resolve = makeProblemRuntimeResolver(JSON.stringify({ "sqli-demo": CONTAINER }));
    expect(resolve("sqli-demo")).toEqual(CONTAINER);
    expect(resolve("some-aws-problem")).toBeUndefined();
  });

  it("should resolve everything to undefined when the catalog is empty", () => {
    const resolve = makeProblemRuntimeResolver(undefined);
    expect(resolve("sqli-demo")).toBeUndefined();
  });
});

describe("parseProblemRuntimeDescriptors (#2075)", () => {
  it("should decode single-provider entries identically to the legacy parser", () => {
    const raw = JSON.stringify({ "sqli-demo": CONTAINER });
    expect(parseProblemRuntimeDescriptors(raw)).toEqual({ "sqli-demo": CONTAINER });
  });

  it("should preserve a composite entry with its declared target order", () => {
    const raw = JSON.stringify({ "cross-cloud": COMPOSITE });
    expect(parseProblemRuntimeDescriptors(raw)).toEqual({
      "cross-cloud": {
        kind: "composite",
        targets: COMPOSITE.targets,
      },
    });
  });

  it("should return an empty map for unset / empty / malformed env", () => {
    expect(parseProblemRuntimeDescriptors(undefined)).toEqual({});
    expect(parseProblemRuntimeDescriptors("")).toEqual({});
    expect(parseProblemRuntimeDescriptors("{not json")).toEqual({});
    expect(parseProblemRuntimeDescriptors("[]")).toEqual({});
    expect(parseProblemRuntimeDescriptors("null")).toEqual({});
  });

  it("should drop a malformed composite entry without throwing (fail-safe)", () => {
    // A composite with a single target violates MIN_COMPOSITE_TARGETS, so
    // normalizeRuntime throws RuntimeValidationError; the parser must drop the
    // bad entry and keep the valid one rather than crash the whole resolver.
    const raw = JSON.stringify({
      "bad-composite": {
        kind: "composite",
        targets: [{ id: "only-one", provider: "aws", engine: "cloudformation", entry: "t.yaml" }],
      },
      "good-single": CONTAINER,
    });
    expect(parseProblemRuntimeDescriptors(raw)).toEqual({ "good-single": CONTAINER });
  });
});

describe("makeProblemRuntimeDescriptorResolver (#2075)", () => {
  it("should resolve a composite descriptor and undefined for an absent problemId", () => {
    const resolve = makeProblemRuntimeDescriptorResolver(
      JSON.stringify({ "cross-cloud": COMPOSITE }),
    );
    expect(asCompositeDescriptor(resolve("cross-cloud"))).toEqual({
      kind: "composite",
      targets: COMPOSITE.targets,
    });
    expect(resolve("legacy-aws")).toBeUndefined();
  });

  it("should narrow a single descriptor to undefined via asCompositeDescriptor", () => {
    const resolve = makeProblemRuntimeDescriptorResolver(
      JSON.stringify({ "sqli-demo": CONTAINER }),
    );
    expect(asCompositeDescriptor(resolve("sqli-demo"))).toBeUndefined();
  });
});
