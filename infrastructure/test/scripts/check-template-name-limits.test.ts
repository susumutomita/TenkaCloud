import { describe, expect, it } from "vitest";
import { findNameLimitFindings } from "../../../scripts/check-template-name-limits";

/**
 * `scripts/check-template-name-limits.ts` の挙動を pin する unit test。
 *
 * #1812 class の regression 防止: 問題 template が IAM Role の `RoleName` / Lambda の
 * `FunctionName` を `${NamePrefix}` 込みの明示名で宣言すると、 `NamePrefix`
 * (= `tc-{slug(problemId)[:40]}-{slug(teamName)[:40]}` 最大 84 文字) が AWS の 64 文字
 * 上限を超え、 deploy が CREATE_FAILED する (synth / lint は通るので静かに壊れる)。
 *
 * 公開 contract: `findNameLimitFindings` は `${NamePrefix}` を含む `RoleName:` /
 * `FunctionName:` 行を (行番号 + property + 値つきで) 返す。 それ以外は返さない。
 */

describe("findNameLimitFindings", () => {
  it("should flag a RoleName built from the NamePrefix placeholder", () => {
    const yaml = [
      "Resources:",
      "  MyRole:",
      "    Type: AWS::IAM::Role",
      "    Properties:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
      '      RoleName: !Sub "${NamePrefix}-participant-viewer"',
    ].join("\n");
    const findings = findNameLimitFindings(yaml);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.property).toBe("RoleName");
    expect(findings[0]?.line).toBe(5);
  });

  it("should flag a FunctionName built from the NamePrefix placeholder", () => {
    const yaml = [
      "  Fn:",
      "    Type: AWS::Lambda::Function",
      "    Properties:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
      '      FunctionName: !Sub "${NamePrefix}-bucket-cleanup"',
    ].join("\n");
    const findings = findNameLimitFindings(yaml);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.property).toBe("FunctionName");
  });

  it("should flag every overflowable name in a template", () => {
    const yaml = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
      '      RoleName: !Sub "${NamePrefix}-a"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
      '      FunctionName: !Sub "${NamePrefix}-b"',
    ].join("\n");
    expect(findNameLimitFindings(yaml)).toHaveLength(2);
  });

  it("should NOT flag a fixed RoleName that does not use the NamePrefix placeholder", () => {
    const yaml = ["    Properties:", "      RoleName: my-fixed-short-name"].join("\n");
    expect(findNameLimitFindings(yaml)).toEqual([]);
  });

  it("should NOT flag LogGroupName (512-char limit, safe for NamePrefix)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
    const yaml = '      LogGroupName: !Sub "/aws/lambda/${NamePrefix}-bucket-cleanup"';
    expect(findNameLimitFindings(yaml)).toEqual([]);
  });

  it("should NOT match a property whose key merely ends in RoleName", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub literal を pin
    const yaml = '      ServiceLinkedRoleName: !Sub "${NamePrefix}-x"';
    expect(findNameLimitFindings(yaml)).toEqual([]);
  });

  it("should return nothing for a template with no explicit names", () => {
    const yaml = [
      "  MyRole:",
      "    Type: AWS::IAM::Role",
      "    Properties:",
      "      AssumeRolePolicyDocument:",
      "        Version: '2012-10-17'",
    ].join("\n");
    expect(findNameLimitFindings(yaml)).toEqual([]);
  });
});
