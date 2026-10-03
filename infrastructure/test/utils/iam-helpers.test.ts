import { App, Stack } from "aws-cdk-lib";
import type { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { grantChallengePayloadRead } from "../../lib/utils/iam-helpers";

/**
 * Issue #1418: lib/utils/iam-helpers.ts は 50% branch だった。
 * grantChallengePayloadRead の bucket-present / absent 両枝を pin する。
 */
describe("grantChallengePayloadRead", () => {
  it("should add an s3:GetObject statement when a bucket name is given", () => {
    const stack = new Stack(new App({ autoSynth: false }), "T");
    const addToRolePolicy = vi.fn();
    const fn = { addToRolePolicy } as unknown as IFunction;
    grantChallengePayloadRead(stack, fn, "challenge-payloads");
    expect(addToRolePolicy).toHaveBeenCalledTimes(1);
    const stmt = (addToRolePolicy.mock.calls[0][0] as PolicyStatement).toJSON() as {
      Action: string;
      Resource: string;
    };
    expect(stmt.Action).toBe("s3:GetObject");
    // partition is an unresolved CDK token at synth-less test time, so match the stable suffix.
    expect(stmt.Resource).toContain(":s3:::challenge-payloads/*");
  });

  it("should be a no-op when the bucket name is undefined or empty", () => {
    const stack = new Stack(new App({ autoSynth: false }), "T");
    const addToRolePolicy = vi.fn();
    const fn = { addToRolePolicy } as unknown as IFunction;
    grantChallengePayloadRead(stack, fn, undefined);
    grantChallengePayloadRead(stack, fn, "");
    expect(addToRolePolicy).not.toHaveBeenCalled();
  });
});
