import { describe, expect, it } from "vitest";
import {
  flagMatches,
  runFlagKind,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/flag";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { FlagScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `flag` kind は polling 経由では **no-op**。 採点は POST `/submit-flag` 経路で
 * event-triggered に走る (= submit-flag.ts)。 本 test は dispatcher が flag kind を
 * skip すること、 `flagMatches` 共通 helper が submit-flag.ts と同 logic を共有する
 * ことを pin する。
 */

describe("flag kind in polling dispatcher", () => {
  it("polling 経由では何もしないべき (= scoreDelta=0、 scoreEvents 空)", () => {
    const input: KindHandlerInput<FlagScoringMetadata> = {
      deployment: { PK: "DEPLOYMENT#JOB1", jobId: "JOB1", problemId: "hello-world" },
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
      slots: [],
      overrides: [],
      phases: [] as readonly PhaseEntry[],
      nowMs: 0,
      nowIso: "2026-05-12T10:00:00.000Z",
      prevState: {},
    };
    const result = runFlagKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
  });
});

describe("flagMatches (shared helper、 submit-flag と共有)", () => {
  it("一致するなら true", () => {
    expect(flagMatches("hello", "hello")).toBe(true);
  });

  it("両端 trim 後の一致を判定すべき", () => {
    expect(flagMatches("  hello  ", "hello")).toBe(true);
    expect(flagMatches("hello\n", "hello")).toBe(true);
  });

  it("大文字小文字は区別すべき (= case-sensitive)", () => {
    expect(flagMatches("Hello", "hello")).toBe(false);
  });

  it("中央のスペースは区別すべき", () => {
    expect(flagMatches("hello world", "hello  world")).toBe(false);
  });
});
