import { describe, expect, it } from "vitest";
import { bucketFor, checkTemplates, measureEnvVariables } from "./lambda-env-size.ts";

/**
 * Issue #1309 lambda-env-size rule unit tests。
 * 実 cdk.out には依存させず、 CFn template fixture を inline で組んで checkTemplates を
 * 直接 drive する (= fast / hermetic)。
 */

function makeTemplate(
  resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>,
) {
  return { Resources: resources };
}

function makeLambda(envVars: Record<string, unknown>) {
  return {
    Type: "AWS::Lambda::Function",
    Properties: {
      Environment: {
        Variables: envVars,
      },
    },
  };
}

describe("measureEnvVariables", () => {
  it("should return zero total for empty env", () => {
    expect(measureEnvVariables({})).toEqual({
      totalBytes: 0,
      largestKey: "",
      largestBytes: 0,
    });
  });

  it("should exact-count string values via UTF-8 byte length", () => {
    // "A=1" = 1 (key) + 1 (value) + 2 (delim overhead) = 4 bytes
    const r = measureEnvVariables({ A: "1" });
    expect(r.totalBytes).toBe(4);
    expect(r.largestKey).toBe("A");
  });

  it("should sum multi-entry env correctly", () => {
    const r = measureEnvVariables({ A: "1", BB: "22" });
    // A: 1 + 1 + 2 = 4; BB: 2 + 2 + 2 = 6; total 10
    expect(r.totalBytes).toBe(10);
    expect(r.largestKey).toBe("BB");
  });

  it("should identify the largest env var", () => {
    const r = measureEnvVariables({
      SMALL: "x",
      BIG: "x".repeat(1000),
      MEDIUM: "x".repeat(100),
    });
    expect(r.largestKey).toBe("BIG");
  });

  it("should estimate CFn intrinsic (object) values as 200 bytes", () => {
    const r = measureEnvVariables({ TABLE_NAME: { Ref: "TableX" } });
    // 10 (key) + 200 (estimate) + 2 (delim) = 212
    expect(r.totalBytes).toBe(212);
  });

  it("should handle multibyte UTF-8 string values", () => {
    // 日本語 1 文字 = 3 bytes (UTF-8)
    const r = measureEnvVariables({ K: "あ" });
    expect(r.totalBytes).toBe(1 + 3 + 2);
  });
});

describe("bucketFor", () => {
  it("should return ok for under 2.5KB", () => {
    expect(bucketFor(2559)).toBe("ok");
    expect(bucketFor(0)).toBe("ok");
  });

  it("should return ge-warning for 2.5KB-3KB", () => {
    expect(bucketFor(2560)).toBe("ge-warning");
    expect(bucketFor(3071)).toBe("ge-warning");
  });

  it("should return ge-error for 3KB-4KB", () => {
    expect(bucketFor(3072)).toBe("ge-error");
    expect(bucketFor(4095)).toBe("ge-error");
  });

  it("should return ge-hard-limit for >= 4KB (= AWS reject)", () => {
    expect(bucketFor(4096)).toBe("ge-hard-limit");
    expect(bucketFor(5000)).toBe("ge-hard-limit");
  });
});

describe("checkTemplates", () => {
  it("should return no findings when all Lambdas are under 2.5KB", () => {
    const templates = [
      {
        relPath: "infrastructure/cdk.out/small.template.json",
        stackName: "small",
        template: makeTemplate({
          Fn1: makeLambda({ K: "v" }),
        }),
      },
    ];
    expect(checkTemplates({ templates })).toEqual([]);
  });

  it("should report warning for Lambda env between 2.5KB and 3KB", () => {
    // 2600 bytes = 1 (key) + 2597 (value) + 2 (delim) = 2600
    const big = "x".repeat(2597);
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/warn.template.json",
          stackName: "warn-stack",
          template: makeTemplate({ WarnFn: makeLambda({ K: big }) }),
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("warn-stack::WarnFn::ge-warning");
  });

  it("should report error for Lambda env between 3KB and 4KB", () => {
    const big = "x".repeat(3100);
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/err.template.json",
          stackName: "err-stack",
          template: makeTemplate({ ErrFn: makeLambda({ K: big }) }),
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("err-stack::ErrFn::ge-error");
  });

  it("should report error and call out the hard limit when env >= 4KB", () => {
    const big = "x".repeat(4100);
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/overflow.template.json",
          stackName: "overflow-stack",
          template: makeTemplate({ OverflowFn: makeLambda({ K: big }) }),
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("overflow-stack::OverflowFn::ge-hard-limit");
    expect(findings[0]?.message).toContain("hard limit");
  });

  it("should identify the largest env var in the finding message", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/multi.template.json",
          stackName: "multi-stack",
          template: makeTemplate({
            BigFn: makeLambda({
              SMALL_VAR: "x",
              CATALOG_BLOB: "x".repeat(3100),
              MEDIUM_VAR: "x".repeat(100),
            }),
          }),
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("CATALOG_BLOB");
  });

  it("should only report the violating Lambda when multiple exist", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/mixed.template.json",
          stackName: "mixed-stack",
          template: makeTemplate({
            OkFn: makeLambda({ K: "small" }),
            BadFn: makeLambda({ K: "x".repeat(3100) }),
          }),
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toContain("BadFn");
  });

  it("should walk multiple stack templates", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/a.template.json",
          stackName: "a",
          template: makeTemplate({ Fn1: makeLambda({ K: "x".repeat(3100) }) }),
        },
        {
          relPath: "infrastructure/cdk.out/b.template.json",
          stackName: "b",
          template: makeTemplate({ Fn2: makeLambda({ K: "x".repeat(2600) }) }),
        },
      ],
    });
    expect(findings).toHaveLength(2);
    const matches = findings.map((f) => f.match).sort();
    expect(matches).toEqual(["a::Fn1::ge-error", "b::Fn2::ge-warning"]);
  });

  it("should ignore non-Lambda resources", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/dynamo.template.json",
          stackName: "ddb",
          template: {
            Resources: {
              TableX: {
                Type: "AWS::DynamoDB::Table",
                Properties: { TableName: "x".repeat(4000) },
              },
            },
          },
        },
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it("should handle Lambda with no env block (= undefined Properties.Environment)", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/noenv.template.json",
          stackName: "noenv",
          template: {
            Resources: {
              Fn1: { Type: "AWS::Lambda::Function", Properties: {} },
            },
          },
        },
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it("should include remediation pointing to S3 / SSM / bundling.define", () => {
    const findings = checkTemplates({
      templates: [
        {
          relPath: "infrastructure/cdk.out/rec.template.json",
          stackName: "rec",
          template: makeTemplate({ Fn1: makeLambda({ K: "x".repeat(3100) }) }),
        },
      ],
    });
    expect(findings[0]?.recommendation).toMatch(/bundling\.define/);
    expect(findings[0]?.recommendation).toMatch(/S3/);
    expect(findings[0]?.recommendation).toMatch(/SSM/);
    expect(findings[0]?.recommendation).toMatch(/#1308/);
  });
});
