import { describe, expect, it } from "vitest";
import type { SourceBundleConfig } from "../../lib/config/config-interface";
import { buildSourceBundleLifecyclePolicy } from "../../lib/source-bundle/lifecycle-policy";

/**
 * Issue #1056: deploy artifact bucket の lifecycle policy 生成を pin する。
 * 設定値は `infrastructure/environments/<env>/config.json` の `sourceBundleConfig` から
 * 読まれる。 builder は数値正規化 + default fallback + AWS API shape 構築を担う。
 */
describe("buildSourceBundleLifecyclePolicy (Issue #1056)", () => {
  it("config 未指定なら default (= 5 世代 / 1 日) で組み立てるべき", () => {
    const policy = buildSourceBundleLifecyclePolicy(undefined);
    const [rule] = policy.Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(5);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(1);
  });

  it("config の number 値はそのまま AWS shape に流すべき", () => {
    const config: SourceBundleConfig = { keepNoncurrentVersions: 10, expireAfterDays: 3 };
    const [rule] = buildSourceBundleLifecyclePolicy(config).Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(10);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(3);
  });

  it("placeholder 展開後の string 値も number に正規化すべき", () => {
    const config: SourceBundleConfig = { keepNoncurrentVersions: "7", expireAfterDays: "2" };
    const [rule] = buildSourceBundleLifecyclePolicy(config).Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(7);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(2);
  });

  it("Status は Enabled で固定すべき", () => {
    const [rule] = buildSourceBundleLifecyclePolicy(undefined).Rules;
    expect(rule.Status).toBe("Enabled");
  });

  it("Filter は空オブジェクトで bucket 全 object を対象とすべき", () => {
    const [rule] = buildSourceBundleLifecyclePolicy(undefined).Rules;
    expect(rule.Filter).toEqual({});
  });

  it("非整数 / 0 / 負値は throw すべき (= deploy 前に misconfig を検出)", () => {
    expect(() =>
      buildSourceBundleLifecyclePolicy({ keepNoncurrentVersions: 0, expireAfterDays: 1 }),
    ).toThrow();
    expect(() =>
      buildSourceBundleLifecyclePolicy({ keepNoncurrentVersions: -1, expireAfterDays: 1 }),
    ).toThrow();
    expect(() =>
      buildSourceBundleLifecyclePolicy({ keepNoncurrentVersions: 1.5, expireAfterDays: 1 }),
    ).toThrow();
    expect(() =>
      buildSourceBundleLifecyclePolicy({ keepNoncurrentVersions: "abc", expireAfterDays: 1 }),
    ).toThrow();
  });
});
