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
    it('Action: "*" を 1 件以上含むなら finding を返すべき', () => {
      const findings = findIamActionWildcardFindings(PATH, "Resources.A.Properties", ["*"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("iam-action-wildcard");
    });

    it('Action 配列に "*" が無ければ 0 件にすべき', () => {
      expect(findIamActionWildcardFindings(PATH, "loc", ["s3:GetObject", "s3:PutObject"])).toEqual(
        [],
      );
    });

    it('複数の "*" は複数 finding として返すべき (= 同 statement 内重複も検出)', () => {
      expect(findIamActionWildcardFindings(PATH, "loc", ["*", "*", "s3:GetObject"])).toHaveLength(
        2,
      );
    });
  });

  describe("findIamResourceWildcardFindings", () => {
    it('Resource: "*" + allowlist 外の action なら finding を返すべき', () => {
      const findings = findIamResourceWildcardFindings(PATH, "loc", ["*"], ["s3:DeleteObject"]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("iam-resource-wildcard");
      expect(findings[0]?.detail).toContain("s3:DeleteObject");
    });

    it('Resource: "*" + allowlist 内 action だけなら finding を返さないべき', () => {
      const findings = findIamResourceWildcardFindings(
        PATH,
        "loc",
        ["*"],
        ["ec2:DescribeRegions", "sts:GetCallerIdentity"],
      );
      expect(findings).toEqual([]);
    });

    it('Resource: "*" が無ければ 0 件にすべき (= scoped ARN は OK)', () => {
      expect(
        findIamResourceWildcardFindings(
          PATH,
          "loc",
          ["arn:aws:s3:::my-bucket/*"],
          ["s3:GetObject"],
        ),
      ).toEqual([]);
    });

    it('Resource: "*" + action 空配列なら finding を返すべき (= allowlist 判定不能)', () => {
      const findings = findIamResourceWildcardFindings(PATH, "loc", ["*"], []);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.detail).toContain("Resource");
    });
  });

  describe("findSgOpenNonWebFinding", () => {
    it("0.0.0.0/0 から 80/443 以外への ingress は finding を返すべき", () => {
      const finding = findSgOpenNonWebFinding(PATH, "Sg", 0, {
        CidrIp: "0.0.0.0/0",
        FromPort: 22,
      });
      expect(finding?.rule).toBe("sg-open-non-web");
      expect(finding?.detail).toContain("port 22");
    });

    it("0.0.0.0/0 + 80 / 443 は finding を返さないべき (= 競技 web は OK)", () => {
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "0.0.0.0/0", FromPort: 80 }),
      ).toBeUndefined();
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "0.0.0.0/0", FromPort: 443 }),
      ).toBeUndefined();
    });

    it("CidrIp が 0.0.0.0/0 でないなら finding を返さないべき", () => {
      expect(
        findSgOpenNonWebFinding(PATH, "Sg", 0, { CidrIp: "10.0.0.0/8", FromPort: 22 }),
      ).toBeUndefined();
    });

    it("FromPort が string でも number に変換して判定すべき", () => {
      const finding = findSgOpenNonWebFinding(PATH, "Sg", 1, {
        CidrIp: "0.0.0.0/0",
        FromPort: "22",
      });
      expect(finding?.location).toBe("Resources.Sg.Properties.SecurityGroupIngress[1]");
    });
  });
});
