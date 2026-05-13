import { describe, expect, it, vi } from "vitest";
import {
  parseProblemsVisibility,
  resolveChallengePayloadBucket,
} from "../../lib/problem-deploy/handlers/shared/visibility";

/**
 * ADR-008 Phase 3 (Issue #642): BATTLE_PROBLEMS_VISIBILITY env のパーサと
 * presigned URL 発行可否判定の pin。 dormant-default と fail-safe parse の挙動を検証する。
 */
describe("parseProblemsVisibility (Issue #642)", () => {
  it("undefined / 空文字列なら空 map を返すべき (= 全 public 扱い)", () => {
    expect(parseProblemsVisibility(undefined)).toEqual({});
    expect(parseProblemsVisibility("")).toEqual({});
  });

  it("不正な JSON は warn しつつ空 map を返すべき (= fail-safe)", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseProblemsVisibility("{not json")).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("JSON でも array / 非 object なら空 map を返すべき", () => {
    expect(parseProblemsVisibility("[]")).toEqual({});
    expect(parseProblemsVisibility('"private"')).toEqual({});
    expect(parseProblemsVisibility("42")).toEqual({});
  });

  it('value が "private" のキーだけ抜き出すべき', () => {
    const raw = JSON.stringify({
      "secret-problem": "private",
      "public-problem": "public",
      "stale-entry": "deprecated",
    });
    expect(parseProblemsVisibility(raw)).toEqual({ "secret-problem": "private" });
  });
});

describe("resolveChallengePayloadBucket (Issue #642)", () => {
  it("bucketName 未設定なら undefined (= dormant)", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "secret-problem",
        visibility: { "secret-problem": "private" },
        bucketName: undefined,
      }),
    ).toBeUndefined();
  });

  it("bucketName あっても visibility に該当 id が無ければ undefined", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "public-problem",
        visibility: { "secret-problem": "private" },
        bucketName: "tc-challenges-test",
      }),
    ).toBeUndefined();
  });

  it("visibility が undefined でも安全に undefined を返すべき", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "any-problem",
        visibility: undefined,
        bucketName: "tc-challenges-test",
      }),
    ).toBeUndefined();
  });

  it("bucketName + visibility 両方揃ったら bucket 名を返すべき", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "secret-problem",
        visibility: { "secret-problem": "private" },
        bucketName: "tc-challenges-test",
      }),
    ).toBe("tc-challenges-test");
  });
});
