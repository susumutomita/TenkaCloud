import { describe, expect, it } from "vitest";
import type { SourceBundleConfig } from "../../lib/config/config-interface";
import { buildSourceBundleLifecyclePolicy } from "../../lib/source-bundle/lifecycle-policy";

/**
 * Issue #1056: deploy artifact bucket の lifecycle policy 生成を pin する。
 * 設定値は `infrastructure/environments/<env>/config.json` の `sourceBundleConfig` から
 * 読まれる。 builder は数値正規化 + default fallback + AWS API shape 構築を担う。
 */
describe("buildSourceBundleLifecyclePolicy (Issue #1056)", () => {
  it("should build with defaults (5 versions / 1 day) when config is unset", () => {
    const policy = buildSourceBundleLifecyclePolicy(undefined);
    const [rule] = policy.Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(5);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(1);
  });

  it("should pass config number values straight through to the AWS shape", () => {
    const config: SourceBundleConfig = { keepNoncurrentVersions: 10, expireAfterDays: 3 };
    const [rule] = buildSourceBundleLifecyclePolicy(config).Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(10);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(3);
  });

  it("should also normalize post-placeholder-expanded string values to numbers", () => {
    const config: SourceBundleConfig = { keepNoncurrentVersions: "7", expireAfterDays: "2" };
    const [rule] = buildSourceBundleLifecyclePolicy(config).Rules;
    expect(rule.NoncurrentVersionExpiration.NewerNoncurrentVersions).toBe(7);
    expect(rule.NoncurrentVersionExpiration.NoncurrentDays).toBe(2);
  });

  it("Status should be fixed to Enabled", () => {
    const [rule] = buildSourceBundleLifecyclePolicy(undefined).Rules;
    expect(rule.Status).toBe("Enabled");
  });

  it("Filter should target all bucket objects via an empty object", () => {
    const [rule] = buildSourceBundleLifecyclePolicy(undefined).Rules;
    expect(rule.Filter).toEqual({});
  });

  it("should throw on non-integer / 0 / negative (detect misconfig before deploy)", () => {
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
