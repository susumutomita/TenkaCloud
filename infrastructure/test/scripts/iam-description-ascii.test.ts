import { describe, expect, it } from "vitest";
import {
  collectStrings,
  firstDisallowedChar,
  formatCodePoint,
  scanTemplateForIamDescriptions,
} from "../../../scripts/lib/iam-description-ascii";

/**
 * [Issue #664 follow-up] IAM Description Latin-1 gate — pure logic pin.
 *
 * The real bug: ChallengePayloadStack's PublishRole description interpolated a token, so it
 * synthesized to an `Fn::Join` whose literal fragment held a U+2192 arrow — outside IAM's allowed
 * range — and CloudFormation `CREATE_FAILED`. These tests pin that the scanner catches that exact
 * shape (intrinsic-wrapped IAM description) plus plain-string CJK, and ignores non-IAM resources.
 */

const ARROW = "→"; // → — the char that failed the deploy

describe("firstDisallowedChar", () => {
  it("should allow tab/LF/CR + printable ASCII + Latin-1 supplement", () => {
    expect(
      firstDisallowedChar("Publish role for repo -> bucket. S3 publication only."),
    ).toBeUndefined();
    expect(firstDisallowedChar("café résumé naïve ÿ")).toBeUndefined(); // Latin-1 supplement ok
    expect(firstDisallowedChar("\t\n\r")).toBeUndefined();
  });

  it("should flag a U+2192 arrow, an em-dash, and CJK", () => {
    expect(firstDisallowedChar(`a ${ARROW} b`)).toEqual({ char: ARROW, codePoint: 0x2192 });
    expect(firstDisallowedChar("a — b")?.codePoint).toBe(0x2014); // em-dash
    expect(firstDisallowedChar("テナント")?.codePoint).toBe(0x30c6); // CJK
  });
});

describe("collectStrings (recurse intrinsics)", () => {
  it("should collect a plain string", () => {
    expect(collectStrings("hello")).toEqual(["hello"]);
  });

  it("should collect literal fragments out of an Fn::Join, recursing object values not keys", () => {
    const join = { "Fn::Join": ["", [`lit ${ARROW} `, { Ref: "Bucket83908E77" }, " tail"]] };
    expect(collectStrings(join)).toEqual(["", `lit ${ARROW} `, "Bucket83908E77", " tail"]);
  });

  it("should return [] for non-string scalars", () => {
    expect(collectStrings(42)).toEqual([]);
    expect(collectStrings(null)).toEqual([]);
  });
});

describe("formatCodePoint", () => {
  it("should format as U+XXXX", () => {
    expect(formatCodePoint(0x2192)).toBe("U+2192");
    expect(formatCodePoint(0x9)).toBe("U+0009");
  });
});

describe("scanTemplateForIamDescriptions (#664)", () => {
  const role = (description: unknown) => ({
    Resources: {
      PublishRole: { Type: "AWS::IAM::Role", Properties: { Description: description } },
    },
  });

  it("should flag a U+2192 arrow buried in an Fn::Join IAM Role description (the deploy bug)", () => {
    const template = role({
      "Fn::Join": [
        "",
        [`Publish role for repo ${ARROW} `, { Ref: "Bucket83908E77" }, ". S3 publication only."],
      ],
    });
    const findings = scanTemplateForIamDescriptions(template);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      logicalId: "PublishRole",
      resourceType: "AWS::IAM::Role",
      codePoint: 0x2192,
    });
  });

  it("should flag a plain-string IAM Role description with CJK", () => {
    expect(scanTemplateForIamDescriptions(role("テナント向け role"))).toHaveLength(1);
  });

  it("should flag a ManagedPolicy description too", () => {
    const template = {
      Resources: {
        P: { Type: "AWS::IAM::ManagedPolicy", Properties: { Description: `a ${ARROW} b` } },
      },
    };
    expect(scanTemplateForIamDescriptions(template)).toHaveLength(1);
  });

  it("should pass a clean ASCII / Latin-1 IAM description", () => {
    expect(
      scanTemplateForIamDescriptions(role("Publish role for repo -> bucket. S3 publication only.")),
    ).toEqual([]);
    expect(scanTemplateForIamDescriptions(role(undefined))).toEqual([]);
    expect(scanTemplateForIamDescriptions(role(null))).toEqual([]);
  });

  it("should ignore non-IAM resources even if their Description has CJK (only IAM is constrained)", () => {
    const template = {
      Resources: {
        Q: { Type: "AWS::SQS::Queue", Properties: { Description: `キュー ${ARROW}` } },
        T: { Type: "AWS::DynamoDB::Table", Properties: { Description: "テーブル名" } },
      },
    };
    expect(scanTemplateForIamDescriptions(template)).toEqual([]);
  });

  it("should not throw on a template with no Resources / garbage input", () => {
    expect(scanTemplateForIamDescriptions({})).toEqual([]);
    expect(scanTemplateForIamDescriptions(null)).toEqual([]);
    expect(scanTemplateForIamDescriptions("nope")).toEqual([]);
  });
});
