import { describe, expect, it } from "vitest";
import { iamWildcardNeedsJustify } from "./iam-wildcard-needs-justify.ts";

function ctx(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
  };
}

/**
 * Issue #2218: iam-wildcard-needs-justify was the only harness rule with no tests. Pins its
 * behavior directly (scope filter, justification window, each recognized keyword, error shape)
 * so a future line-scan-helper consolidation (the rest of #2218) can't silently change detection.
 */
describe("iamWildcardNeedsJustify", () => {
  it("should pass when there is no resources wildcard at all", () => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts":
          'new PolicyStatement({\n  resources: ["arn:aws:s3:::bucket"],\n});\n',
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should flag an unjustified resources wildcard", () => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts": 'new PolicyStatement({\n  resources: ["*"],\n});\n',
      }),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]).toMatchObject({
      ruleId: "iam-wildcard-needs-justify",
      severity: "error",
      filePath: "infrastructure/lib/foo.ts",
      line: 2,
      match: 'resources: ["*"],',
    });
  });

  it("should not flag a wildcard preceded by a justify: comment within 10 lines", () => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts":
          "// justify: CloudFormation Describe* has no per-resource ARN by API design\n" +
          'new PolicyStatement({\n  resources: ["*"],\n});\n',
      }),
    );
    expect(findings).toEqual([]);
  });

  it.each([
    ["ConditionExpression", "// ConditionExpression scopes this to the caller's own row"],
    ["conditions:", "conditions: { StringEquals: {} },"],
    ["StringEquals", "// StringEquals narrows by tenantId"],
    ["StringLike", "// StringLike narrows by prefix"],
    ["EncryptionContext", "// KMS Decrypt scoped by EncryptionContext"],
    ["aws-api-required", "// aws-api-required: no ARN form exists"],
    ["api design", "// required by AWS api design"],
    ["API 制約", "// AWS API 制約により ARN 指定不可"],
    ["Issue reference", "// Issue #857: see design doc"],
    ["PR reference", "// PR #857: reviewed"],
    ["SBT vendored", "// SBT vendored: serverless-saas-pipeline upstream code"],
  ])("should recognize the %s justification keyword", (_label, comment) => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts": `${comment}\nnew PolicyStatement({\n  resources: ["*"],\n});\n`,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should look up to 9 lines after the wildcard for a justification too", () => {
    const filler = Array.from({ length: 8 }, () => "// filler").join("\n");
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts": `resources: ["*"],\n${filler}\n// justify: trailing note\n`,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should not look beyond the 10-line window for a justification", () => {
    const filler = Array.from({ length: 11 }, () => "// filler").join("\n");
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts": `resources: ["*"],\n${filler}\n// justify: too far away\n`,
      }),
    );
    expect(findings.length).toBe(1);
  });

  it("should only inspect infrastructure/lib/**/*.ts files", () => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/test/foo.test.ts": 'resources: ["*"],\n',
        "apps/foo/src/bar.ts": 'resources: ["*"],\n',
        "infrastructure/lib/foo.md": 'resources: ["*"],\n',
      }),
    );
    expect(findings).toEqual([]);
  });

  it("should skip a file it cannot read instead of throwing", () => {
    const findings = iamWildcardNeedsJustify.check({
      files: ["infrastructure/lib/missing.ts"],
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(findings).toEqual([]);
  });

  it("should report one finding per unjustified wildcard line", () => {
    const findings = iamWildcardNeedsJustify.check(
      ctx({
        "infrastructure/lib/foo.ts": 'resources: ["*"],\n\n\n\n\n\n\n\n\n\n\nresources: ["*"],\n',
      }),
    );
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.line)).toEqual([1, 12]);
  });
});
