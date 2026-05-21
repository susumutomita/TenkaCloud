import { describe, expect, it } from "vitest";
import {
  extractParticipantViewerBlock,
  findMissingRequiredPolicies,
} from "../../../scripts/check-template-cli-access";

/**
 * `scripts/check-template-cli-access.ts` の挙動を pin する unit test。
 *
 * 公開 contract:
 *   - `extractParticipantViewerBlock` は ParticipantViewerRole の properties block を
 *     文字列で切り出す (= 次の top-level Resource / section に当たった所で打ち切る)
 *   - `findMissingRequiredPolicies` は AWSSignInLocalDevelopmentAccess /
 *     AWSCloudShellFullAccess のうち block 中に出現しないものを返す
 */

describe("extractParticipantViewerBlock", () => {
  it("should return the ParticipantViewerRole properties block until the next top-level Resource", () => {
    const yaml = [
      "Resources:",
      "  ParticipantViewerRole:",
      "    Type: AWS::IAM::Role",
      "    Properties:",
      "      RoleName: foo",
      "  OtherResource:",
      "    Type: AWS::S3::Bucket",
    ].join("\n");
    const block = extractParticipantViewerBlock(yaml);
    expect(block).toBeDefined();
    expect(block).toContain("ParticipantViewerRole:");
    expect(block).toContain("RoleName: foo");
    expect(block).not.toContain("OtherResource");
  });

  it("should stop at the next top-level section (e.g. Outputs)", () => {
    const yaml = [
      "Resources:",
      "  ParticipantViewerRole:",
      "    Type: AWS::IAM::Role",
      "    Properties:",
      "      RoleName: foo",
      "Outputs:",
      "  Arn: !GetAtt ParticipantViewerRole.Arn",
    ].join("\n");
    const block = extractParticipantViewerBlock(yaml);
    expect(block).toContain("RoleName: foo");
    expect(block).not.toContain("Outputs:");
  });

  it("should return undefined when the role is missing", () => {
    const yaml = "Resources:\n  OnlyOtherRole:\n    Type: AWS::IAM::Role\n";
    expect(extractParticipantViewerBlock(yaml)).toBeUndefined();
  });
});

describe("findMissingRequiredPolicies", () => {
  it("should report both policies missing when block has no ManagedPolicyArns", () => {
    const block = [
      "  ParticipantViewerRole:",
      "    Type: AWS::IAM::Role",
      "    Properties:",
      "      RoleName: foo",
    ].join("\n");
    const missing = findMissingRequiredPolicies(block);
    expect(missing.map((m) => m.arnSuffix)).toEqual([
      ":policy/AWSSignInLocalDevelopmentAccess",
      ":policy/AWSCloudShellFullAccess",
    ]);
  });

  it("should report only CloudShell missing when SignIn is attached but CloudShell is not", () => {
    const block = [
      "  ParticipantViewerRole:",
      "    Properties:",
      "      ManagedPolicyArns:",
      "        - arn:aws:iam::aws:policy/AWSSignInLocalDevelopmentAccess",
    ].join("\n");
    const missing = findMissingRequiredPolicies(block);
    expect(missing.map((m) => m.arnSuffix)).toEqual([":policy/AWSCloudShellFullAccess"]);
  });

  it("should report no missing when both policies are attached", () => {
    const block = [
      "  ParticipantViewerRole:",
      "    Properties:",
      "      ManagedPolicyArns:",
      "        - arn:aws:iam::aws:policy/AWSSignInLocalDevelopmentAccess",
      "        - arn:aws:iam::aws:policy/AWSCloudShellFullAccess",
    ].join("\n");
    expect(findMissingRequiredPolicies(block)).toEqual([]);
  });

  it("should accept !Sub style ARN strings (suffix-based matching)", () => {
    const block = [
      "  ParticipantViewerRole:",
      "    Properties:",
      "      ManagedPolicyArns:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub の literal を pin する意図
      '        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSSignInLocalDevelopmentAccess"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CFn !Sub の literal を pin する意図
      '        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSCloudShellFullAccess"',
    ].join("\n");
    expect(findMissingRequiredPolicies(block)).toEqual([]);
  });
});
