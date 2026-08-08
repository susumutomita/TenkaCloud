import { describe, expect, it } from "vitest";
import { resolveBundlingStacks } from "../../lib/app-config/bundling-context";

/**
 * Regression: a platinum (silo) tenant deploy failed inside CodeBuild because synth builds the
 * whole app, so `@aws-cdk/aws-lambda-python-alpha` tried to Docker-build ControlPlaneStack's
 * Lambda — a stack that deploy was not even targeting — and that build died with
 * `pip install pipenv poetry` exit 255. Scoping `aws:cdk:bundling-stacks` to the stack actually
 * being deployed is the fix, but the same knob can silently stub out a stack's real Lambda code
 * if it resolves wrongly, so the resolution rules are pinned here rather than left inline in
 * bin/infrastructure.ts (which cannot be imported without synthesising the entire app).
 */
describe("resolveBundlingStacks", () => {
  it("should skip every stack when CDK_SKIP_BUNDLING=1 (make check-synth)", () => {
    expect(resolveBundlingStacks({ CDK_SKIP_BUNDLING: "1" })).toEqual([]);
  });

  it("should ignore CDK_BUNDLING_STACKS while CDK_SKIP_BUNDLING wins", () => {
    expect(
      resolveBundlingStacks({ CDK_SKIP_BUNDLING: "1", CDK_BUNDLING_STACKS: "tenkacloud-a" }),
    ).toEqual([]);
  });

  it("should leave the context unset when neither variable is present", () => {
    expect(resolveBundlingStacks({})).toBeUndefined();
  });

  it("should treat any CDK_SKIP_BUNDLING value other than 1 as not set", () => {
    expect(resolveBundlingStacks({ CDK_SKIP_BUNDLING: "true" })).toBeUndefined();
    expect(resolveBundlingStacks({ CDK_SKIP_BUNDLING: "0" })).toBeUndefined();
  });

  it("should scope bundling to the single stack a tenant provisioning build deploys", () => {
    expect(
      resolveBundlingStacks({
        CDK_BUNDLING_STACKS: "tenkacloud-tenant-template-2e5cfa42-bb54-40ac-8bea-78f4390727ec",
      }),
    ).toEqual(["tenkacloud-tenant-template-2e5cfa42-bb54-40ac-8bea-78f4390727ec"]);
  });

  it("should accept a comma-separated list and trim surrounding whitespace", () => {
    expect(resolveBundlingStacks({ CDK_BUNDLING_STACKS: " a , b ,c " })).toEqual(["a", "b", "c"]);
  });

  // An empty-ish value must NOT collapse to `[]`. `[]` means "skip bundling for every stack",
  // which would deploy the target stack with stub Lambda assets — a silent, shipped-to-AWS
  // failure far worse than not scoping at all.
  it("should fall back to the default (bundle everything) when the list is effectively empty", () => {
    expect(resolveBundlingStacks({ CDK_BUNDLING_STACKS: "" })).toBeUndefined();
    expect(resolveBundlingStacks({ CDK_BUNDLING_STACKS: "   " })).toBeUndefined();
    expect(resolveBundlingStacks({ CDK_BUNDLING_STACKS: " , , " })).toBeUndefined();
  });
});
