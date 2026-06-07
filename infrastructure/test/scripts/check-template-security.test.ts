import { describe, expect, it } from "vitest";
import {
  findIamActionWildcardFindings,
  findIamResourceWildcardFindings,
  findSgOpenNonWebFinding,
} from "../../../scripts/check-template-security";

/**
 * Issue #869 / #1124: pre-deploy security scanner の helper を pin する。
 *
 * `checkIamWildcards` / `checkSgIngress` から抽出した pure helper を直接 unit-test し、
 * 「危険パターンを正しく拾う」 「allowlist で誤検出しない」 という規約を docs / regression
 * の両面で固定する。
 */

const PATH = "problems/test/template.yaml";

describe("check-template-security helpers (#869 + #1124)", () => {
  describe("findIamActionWildcardFindings", () => {
    it('should return a finding when at least one Action: "*" is present', () => {
      const findings = findIamActionWildcardFindings(PATH, "Resources.A.Properties", ["*"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("iam-action-wildcard");
    });

    it('should return 0 findings when the Action array contains no "*"', () => {
      expect(findIamActionWildcardFindings(PATH, "loc", ["s3:GetObject", "s3:PutObject"])).toEqual(
        [],
      );
    });

    it('should return multiple findings for multiple "*"s (detect duplicates within the same statement)', () => {
      expect(findIamActionWildcardFindings(PATH, "loc", ["*", "*", "s3:GetObject"])).toHaveLength(
        2,
      );
    });

    it('should not flag Action: "*" on an explicit Deny statement (deny narrows access, never grants)', () => {
      expect(findIamActionWildcardFindings(PATH, "loc", ["*"], "Deny")).toEqual([]);
    });
  });

  describe("findIamResourceWildcardFindings", () => {
    it('should return a finding for Resource: "*" + actions outside the allowlist', () => {
      const findings = findIamResourceWildcardFindings(PATH, "loc", ["*"], ["s3:DeleteObject"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("iam-resource-wildcard");
      expect(findings[0]?.detail).toContain("s3:DeleteObject");
    });

    it('should not return a finding for Resource: "*" + actions strictly within the allowlist', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        ["ec2:DescribeRegions", "sts:GetCallerIdentity"],
      );
      expect(findings).toEqual([]);
    });

    it('should not return a finding for Resource: "*" when a NamePrefix tag condition scopes the statement', () => {
      const findings = findIamResourceWildcardFindings(PATH, "loc", ["*"], ["ec2:CreateTags"], {
        StringEquals: {
          "aws:RequestTag/TenkaCloud:NamePrefix": "tc-demo-team",
        },
      });
      expect(findings).toEqual([]);
    });

    it("should not return a finding when an AWS service-specific condition scopes the statement to NamePrefix", () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        ["application-autoscaling:RegisterScalableTarget"],
        {
          StringLike: {
            "application-autoscaling:resource-id": "service/NamePrefix*",
          },
        },
      );
      expect(findings).toEqual([]);
    });

    it('should allow the CloudShell participant baseline on Resource: "*"', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        [
          "cloudshell:CreateEnvironment",
          "cloudshell:CreateSession",
          "cloudshell:GetEnvironmentStatus",
          "cloudshell:StartEnvironment",
          "cloudshell:StopEnvironment",
          "cloudshell:DeleteEnvironment",
          "cloudshell:PutCredentials",
        ],
      );
      expect(findings).toEqual([]);
    });

    it('should not flag Resource: "*" on an explicit Deny statement (deny narrows access, never grants)', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        ["ec2:DescribeInstanceAttribute"],
        undefined,
        "Deny",
      );
      expect(findings).toEqual([]);
    });

    it('should allow ec2:DescribeNetworkAcls on Resource: "*" (EC2 Describe* has no resource-level permissions)', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        ["ec2:DescribeNetworkAcls", "ec2:DescribeInstances"],
      );
      expect(findings).toEqual([]);
    });

    it('should allow rds:Describe* console list verbs alongside elbv2 Describe* on Resource: "*"', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        [
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTargetHealth",
          "rds:DescribeDBClusters",
          "rds:DescribeDBInstances",
        ],
      );
      expect(findings).toEqual([]);
    });

    it('should return 0 findings when Resource: "*" is absent (scoped ARNs are OK)', () => {
      expect(
        findIamResourceWildcardFindings(
          PATH,
          "loc",
          ["arn:aws:s3:::my-bucket/*"],
          ["s3:GetObject"],
        ),
      ).toEqual([]);
    });

    it('should return a finding for Resource: "*" + empty action array (allowlist undecidable)', () => {
      const findings = findIamResourceWildcardFindings(PATH, "loc", ["*"], []);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.detail).toContain("Resource");
    });
  });

  describe("findSgOpenNonWebFinding", () => {
    it("should return a finding for ingress from 0.0.0.0/0 to ports other than 80/443", () => {
      const finding = findSgOpenNonWebFinding(PATH, "Sg", 0, {
        CidrIp: "0.0.0.0/0",
        FromPort: 22,
      });
      expect(finding?.rule).toBe("sg-open-non-web");
      expect(finding?.detail).toContain("port 22");
    });

    it("should not return a finding for 0.0.0.0/0 + 80 / 443 (competition web is OK)", () => {
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "0.0.0.0/0", FromPort: 80 }),
      ).toBeUndefined();
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "0.0.0.0/0", FromPort: 443 }),
      ).toBeUndefined();
    });

    it("should not return a finding when CidrIp is not 0.0.0.0/0", () => {
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "10.0.0.0/8", FromPort: 22 }),
      ).toBeUndefined();
    });

    it("should convert FromPort to a number before evaluating, even if it is a string", () => {
      const finding = findSgOpenNonWebFinding(PATH, "Sg", 1, {
        CidrIp: "0.0.0.0/0",
        FromPort: "22",
      });
      expect(finding?.location).toBe("Resources.Sg.Properties.SecurityGroupIngress[1]");
    });
  });
});
