import { describe, expect, it } from "vitest";
import { buildConsoleDestination } from "../../lib/problem-deploy/handlers/participant-handler/sso";

/**
 * AWS Console federation destination は home に固定する (= サービス固有 deep link を避け、
 * 問題側 IAM スコープに依らない fail-safe な遷移先にする)。 SSM/CFn deep link 経路は
 * Issue #946 でいったん導入したが、 home に倒すことで list view 起因の AccessDenied 経路を
 * 根本的に塞ぐ。
 */

describe("buildConsoleDestination", () => {
  it("should return the AWS Console home URL for the given region", () => {
    const url = buildConsoleDestination({ region: "ap-northeast-1" });
    expect(url).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
    );
  });

  it("should encode the region in the query string (defense-in-depth)", () => {
    const url = buildConsoleDestination({ region: "us-east-1" });
    expect(url).toBe("https://us-east-1.console.aws.amazon.com/console/home?region=us-east-1");
  });

  it("should never reference service-specific consoles (SSM / CFn)", () => {
    const url = buildConsoleDestination({ region: "ap-northeast-1" });
    expect(url).not.toContain("/systems-manager/");
    expect(url).not.toContain("/cloudformation/");
  });
});
