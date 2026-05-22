import { describe, expect, it } from "vitest";
import { buildShellExport, describeRemainingTime } from "../../src/components/CliCredentialsPanel";

/**
 * Issue #1197: CLI credentials panel の純関数 helper を pin する unit test。
 * UI 振る舞い (= reveal toggle / clipboard) は jsdom-only な navigator.clipboard が
 * jest mock 不安定なので、 ここでは shell snippet 生成と TTL countdown ロジックに絞る。
 */

describe("buildShellExport", () => {
  it("should produce 4-line export snippet in bash-compatible syntax", () => {
    const snippet = buildShellExport({
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "SECRETFAKE",
      sessionToken: "TOKENFAKE",
      expiration: "2099-01-01T00:00:00Z",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
    });
    expect(snippet.split("\n")).toEqual([
      "export AWS_ACCESS_KEY_ID=AKIAFAKE",
      "export AWS_SECRET_ACCESS_KEY=SECRETFAKE",
      "export AWS_SESSION_TOKEN=TOKENFAKE",
      "export AWS_REGION=ap-northeast-1",
    ]);
  });
});

describe("describeRemainingTime", () => {
  it("should return remaining label when expiration is in the future", () => {
    const now = Date.parse("2026-05-22T19:00:00Z");
    const expiresAt = new Date(now + 5 * 60 * 1000 + 30 * 1000).toISOString();
    const state = describeRemainingTime(expiresAt, now);
    expect(state).toEqual({ kind: "remaining", label: "5m 30s" });
  });

  it("should return expired when expiration is past now", () => {
    const now = Date.parse("2026-05-22T19:00:00Z");
    const expiresAt = new Date(now - 1).toISOString();
    expect(describeRemainingTime(expiresAt, now)).toEqual({ kind: "expired" });
  });

  it("should return expired when expiration is exactly now (= boundary)", () => {
    const now = Date.parse("2026-05-22T19:00:00Z");
    expect(describeRemainingTime(new Date(now).toISOString(), now)).toEqual({ kind: "expired" });
  });

  it("should return expired when expiration is not a valid ISO string", () => {
    expect(describeRemainingTime("not-an-iso", Date.now())).toEqual({ kind: "expired" });
  });

  it("should pad seconds to 2 digits (e.g. 5m 03s, not 5m 3s)", () => {
    const now = Date.parse("2026-05-22T19:00:00Z");
    const expiresAt = new Date(now + 5 * 60 * 1000 + 3 * 1000).toISOString();
    const state = describeRemainingTime(expiresAt, now);
    expect(state).toEqual({ kind: "remaining", label: "5m 03s" });
  });
});
