/**
 * [Problem Test Harness / Issue #2107] Pack-runner (filesystem discovery) suite.
 *
 * Builds a tiny on-disk pack in a temp directory and runs it through the SDK
 * `validatePackDirectory` + the harness. Only read-only JSON reads happen — no
 * IaC synth, no shell, no network.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackTests } from "../src/pack-runner.js";
import { HarnessError } from "../src/types.js";

let root: string;

function write(rel: string, body: unknown): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function manifest(): unknown {
  return {
    schemaVersion: 1,
    id: "com.example.harness-pack",
    version: "1.0.0",
    core: ">=0.1.0",
    title: "Harness Pack",
    description: "A pack used by the harness runner tests.",
    license: "Apache-2.0",
    problemsRoot: "problems",
    requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runPackTests", () => {
  it("should run a scoring problem's on-disk fixtures from tests/", () => {
    write("tenkacloud-pack.json", manifest());
    write("problems/challenge/hello/metadata.json", {
      id: "hello",
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
    });
    write("problems/challenge/hello/template.yaml", "Resources: {}\n");
    write("problems/challenge/hello/tests/cases.json", [
      {
        name: "ready",
        metadata: {
          id: "hello",
          scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
        },
        runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
        deployment: "ready",
        outputs: { FlagValue: "T{x}" },
        expected: { valid: true, score: "success" },
      },
    ]);

    const result = runPackTests(root);
    expect(result.ok).toBe(true);
    expect(result.packId).toBe("com.example.harness-pack");
    expect(result.results[0].problemId).toBe("hello");
  });

  it("should allow a deploy-only problem without a tests directory", () => {
    write("tenkacloud-pack.json", manifest());
    write("problems/challenge/infra/metadata.json", {
      id: "infra",
      cfnTemplate: "template.yaml",
    });
    write("problems/challenge/infra/template.yaml", "Resources: {}\n");

    const result = runPackTests(root);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it("should raise a harness error when a scoring problem ships no tests", () => {
    write("tenkacloud-pack.json", manifest());
    write("problems/challenge/scored/metadata.json", {
      id: "scored",
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "FlagValue", points: 100 },
    });
    write("problems/challenge/scored/template.yaml", "Resources: {}\n");

    expect(() => runPackTests(root)).toThrow(HarnessError);
  });

  it("should raise a harness error for a missing pack directory", () => {
    expect(() => runPackTests(path.join(root, "does-not-exist"))).toThrow(HarnessError);
  });
});
