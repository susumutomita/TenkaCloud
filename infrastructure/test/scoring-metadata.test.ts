import { describe, expect, it } from "vitest";
import { parseScoringEnv, parseScoringMetadata } from "../lib/utils/scoring-metadata";

/**
 * `lib/utils/scoring-metadata.ts` は CDK synth と Lambda runtime の両方で参照される
 * scoring shape parser。SCHEMA.json と整合した shape narrowing を pin する。
 */

describe("parseScoringMetadata", () => {
  describe("flag 形式", () => {
    it("flagOutputKey + points が揃っていれば narrow するべき", () => {
      expect(
        parseScoringMetadata({ kind: "flag", flagOutputKey: "ParameterValue", points: 100 }),
      ).toEqual({
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        hints: undefined,
      });
    });

    it("hints が string array なら filter して保持するべき", () => {
      expect(
        parseScoringMetadata({
          kind: "flag",
          flagOutputKey: "X",
          points: 1,
          hints: ["use AWS Console", 123, "second hint", null],
        }),
      ).toEqual({
        kind: "flag",
        flagOutputKey: "X",
        points: 1,
        hints: ["use AWS Console", "second hint"],
      });
    });

    it("flagOutputKey が string でない / points が無い / 0 以下は undefined", () => {
      expect(
        parseScoringMetadata({ kind: "flag", flagOutputKey: 123, points: 100 }),
      ).toBeUndefined();
      expect(parseScoringMetadata({ kind: "flag", flagOutputKey: "X" })).toBeUndefined();
      expect(parseScoringMetadata({ kind: "flag", flagOutputKey: "X", points: 0 })).toBeUndefined();
      expect(
        parseScoringMetadata({ kind: "flag", flagOutputKey: "X", points: -1 }),
      ).toBeUndefined();
    });
  });

  describe("uptime 形式", () => {
    it("endpoints が array + pointsPerSuccess が number なら narrow するべき", () => {
      const cfg = {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      };
      expect(parseScoringMetadata(cfg)).toEqual(cfg);
    });

    it("endpoints が array でない / pointsPerSuccess が無いと undefined", () => {
      expect(parseScoringMetadata({ kind: "uptime", pointsPerSuccess: 50 })).toBeUndefined();
      expect(parseScoringMetadata({ kind: "uptime", endpoints: [] })).toBeUndefined();
    });
  });

  describe("無効入力", () => {
    it.each([
      null,
      undefined,
      123,
      "uptime",
      [],
      { kind: "wrong-kind" },
      { points: 100 },
    ])("%s は undefined を返すべき", (input) => {
      expect(parseScoringMetadata(input)).toBeUndefined();
    });
  });
});

describe("parseScoringEnv", () => {
  it("undefined / 空文字 / 壊れた JSON は空 map を返すべき", () => {
    expect(parseScoringEnv(undefined)).toEqual({});
    expect(parseScoringEnv("")).toEqual({});
    expect(parseScoringEnv("{not-json")).toEqual({});
  });

  it("array や primitive は空 map を返すべき", () => {
    expect(parseScoringEnv(JSON.stringify(["x"]))).toEqual({});
    expect(parseScoringEnv(JSON.stringify(123))).toEqual({});
  });

  it("混在 entries は valid なものだけ拾うべき", () => {
    const raw = JSON.stringify({
      "valid-flag": { kind: "flag", flagOutputKey: "X", points: 100 },
      "valid-uptime": {
        kind: "uptime",
        endpoints: [{ outputKey: "Url", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
      "invalid-shape": { kind: "flag" },
      "invalid-kind": { kind: "wrong" },
    });
    const out = parseScoringEnv(raw);
    expect(Object.keys(out).sort()).toEqual(["valid-flag", "valid-uptime"]);
    expect(out["valid-flag"]?.kind).toBe("flag");
    expect(out["valid-uptime"]?.kind).toBe("uptime");
  });
});
