import { describe, expect, it, vi } from "vitest";
import {
  parseProblemsVisibility,
  resolveChallengePayloadBucket,
} from "../../lib/problem-deploy/handlers/shared/visibility";

/**
 * Issue #642: BATTLE_PROBLEMS_VISIBILITY env のパーサと
 * presigned URL 発行可否判定の pin。 dormant-default と fail-safe parse の挙動を検証する。
 */
describe("parseProblemsVisibility (Issue #642)", () => {
  it("should return an empty map for undefined / empty string (treated as all public)", () => {
    expect(parseProblemsVisibility(undefined)).toEqual({});
    expect(parseProblemsVisibility("")).toEqual({});
  });

  it("should warn and return an empty map on invalid JSON (fail-safe)", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseProblemsVisibility("{not json")).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("should return an empty map for JSON arrays / non-objects", () => {
    expect(parseProblemsVisibility("[]")).toEqual({});
    expect(parseProblemsVisibility('"private"')).toEqual({});
    expect(parseProblemsVisibility("42")).toEqual({});
  });

  it('should extract only keys whose value is "private"', () => {
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

  it("should safely return undefined when visibility is undefined", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "any-problem",
        visibility: undefined,
        bucketName: "tc-challenges-test",
      }),
    ).toBeUndefined();
  });

  it("should return the bucket name when bucketName + visibility are both set", () => {
    expect(
      resolveChallengePayloadBucket({
        problemId: "secret-problem",
        visibility: { "secret-problem": "private" },
        bucketName: "tc-challenges-test",
      }),
    ).toBe("tc-challenges-test");
  });
});
