import { describe, expect, it } from "vitest";
import { buildConsoleDestination } from "../../lib/problem-deploy/handlers/participant-handler/sso";

/**
 * Issue #946: AWS Console federation destination の選択ロジックを pin する。
 *
 * 旧挙動: 常に CFn stacks 画面 (= 全 stack list を namePrefix で filter) を destination にしていた。
 * その後 user が SSM Parameter Store サイドバーをクリックすると list view 経由で `ssm:DescribeParameters`
 * AccessDenied になる経路があった (= JAM/GameDay baseline IAM では list 権限を与えない、 PR-933)。
 *
 * 新挙動: stack outputs に `ParameterName` (= SSM Parameter のフルパス) があれば SSM Parameter detail
 * page に直接遷移させる (= list view を経由しないので IAM 不変で動く)。
 */

const REGION = "ap-northeast-1";
const NAME_PREFIX = "tc-hello-world-team-3";

describe("buildConsoleDestination (#946)", () => {
  it("should return the CFn stacks screen when ssmParameterName is unspecified (legacy behavior / multi-resource problems)", () => {
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: undefined,
    });
    expect(url).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks?filteringText=tc-hello-world-team-3",
    );
  });

  it("should return the SSM Parameter detail URL when ssmParameterName is valid (deep link, no list view)", () => {
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: "/tc-hello-world-team-3/hello",
    });
    expect(url).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/systems-manager/parameters/%2Ftc-hello-world-team-3%2Fhello/description?region=ap-northeast-1",
    );
  });

  it("should fall back to CFn when ssmParameterName contains disallowed characters (`#` / `?`) (URL injection guard)", () => {
    const malicious = "/tc#injection?query";
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: malicious,
    });
    // CFn 画面 (= fallback)
    expect(url).toContain("/cloudformation/home");
    expect(url).not.toContain(encodeURIComponent(malicious));
  });

  it("should fall back to CFn when ssmParameterName does not start with `/`", () => {
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: "no-leading-slash",
    });
    expect(url).toContain("/cloudformation/home");
  });

  it("should fall back to CFn when ssmParameterName is empty", () => {
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: "",
    });
    expect(url).toContain("/cloudformation/home");
  });

  it("path 内に `.` / `_` / `-` は許容 (= IAM Parameter naming に合う)", () => {
    const valid = "/tc-x_y.z/sub-key";
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: valid,
    });
    expect(url).toContain("/systems-manager/parameters/");
    expect(url).toContain(encodeURIComponent(valid));
  });

  it("region は URL-encode される (= defense-in-depth、 region は事前 RE validate 済の前提)", () => {
    const url = buildConsoleDestination({
      region: "us-east-1",
      namePrefix: "x",
      ssmParameterName: undefined,
    });
    expect(url).toContain("region=us-east-1");
  });

  it("ssmParameterName が 1023 文字を超えるなら CFn fallback (= URL 長制限の defensive)", () => {
    const tooLong = `/${"a".repeat(1024)}`;
    const url = buildConsoleDestination({
      region: REGION,
      namePrefix: NAME_PREFIX,
      ssmParameterName: tooLong,
    });
    expect(url).toContain("/cloudformation/home");
  });
});
