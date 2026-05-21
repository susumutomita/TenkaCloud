import { describe, expect, it } from "vitest";
import {
  canRenderEndpointOverride,
  canRenderProblemDetailBody,
  isProblemDetailLocked,
} from "../../src/pages/ProblemDetail";

describe("ProblemDetail helpers", () => {
  it("scoring_not_started gate のとき lock 状態にすべき", () => {
    expect(isProblemDetailLocked({ kind: "scoring_not_started" })).toBe(true);
  });

  it("gate が無い / scoring_not_started 以外なら lock しないべき", () => {
    expect(isProblemDetailLocked(undefined)).toBe(false);
    expect(isProblemDetailLocked({ kind: "ok" })).toBe(false);
    expect(isProblemDetailLocked({ kind: "scoring_ended" })).toBe(false);
  });

  it("problem があり lock されていなければ問題本文を表示すべき", () => {
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: false })).toBe(true);
  });

  it("problem 不在または lock 中なら問題本文を表示しないべき", () => {
    expect(canRenderProblemDetailBody({ hasProblem: false, locked: false })).toBe(false);
    expect(canRenderProblemDetailBody({ hasProblem: true, locked: true })).toBe(false);
  });

  it("problem / metadata / endpoint があり lock されていなければ endpoint override を表示すべき", () => {
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 1,
        locked: false,
      }),
    ).toBe(true);
  });

  it("endpoint override の前提が欠けるか lock 中なら表示しないべき", () => {
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 0,
        locked: false,
      }),
    ).toBe(false);
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: false,
        endpointCount: 1,
        locked: false,
      }),
    ).toBe(false);
    expect(
      canRenderEndpointOverride({
        hasProblem: true,
        hasMetadata: true,
        endpointCount: 1,
        locked: true,
      }),
    ).toBe(false);
  });
});
