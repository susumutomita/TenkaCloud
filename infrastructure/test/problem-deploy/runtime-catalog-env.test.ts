import { describe, expect, it } from "vitest";
import {
  makeProblemRuntimeResolver,
  parseProblemRuntimes,
} from "../../lib/problem-deploy/handlers/shared/runtime/runtime-catalog-env.js";

const CONTAINER = { provider: "docker", engine: "compose", entry: "local/docker-compose.yml" };

describe("parseProblemRuntimes (#2054 / ADR-023)", () => {
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
