import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TSCONFIG_PATH = resolve(__dirname, "..", "tsconfig.json");

describe("infrastructure/tsconfig.json exclude", () => {
  it("should exclude both CDK synth output dirs (cdk.out and the test-synth cdk.out.test)", () => {
    // The infra build runs `tsc` with no `include`, so it globs everything under
    // infrastructure/ minus `exclude`. A leftover cdk.out.test/ (test-synth
    // staging renamed in #1295) type-checks staged catalog assets and broke
    // `make deploy`'s build — a `cdk.out` exclude does NOT cover `cdk.out.test`,
    // so both directory names must be listed explicitly.
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    const exclude: string[] = tsconfig.exclude ?? [];

    expect(exclude).toContain("cdk.out");
    expect(exclude).toContain("cdk.out.test");
  });
});
