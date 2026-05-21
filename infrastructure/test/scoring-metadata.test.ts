import { describe, expect, it } from "vitest";
import { parseScoringEnv, parseScoringMetadata } from "../lib/utils/scoring-metadata";

/**
 * `lib/utils/scoring-metadata.ts` は CDK synth と Lambda runtime の両方で参照される
 * scoring shape parser。SCHEMA.json と整合した shape narrowing を pin する。
 */

describe("parseScoringMetadata", () => {
  describe("flag 形式", () => {
    it("should narrow when flagOutputKey + points are both set", () => {
      expect(
        parseScoringMetadata({ kind: "flag", flagOutputKey: "ParameterValue", points: 100 }),
      ).toEqual({
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        hints: undefined,
      });
    });

    it("[#742 Phase 1, v1 legacy] hints が string array なら ProgressiveHint[] に正規化 (penalty=0、 id は source 順位ベース)", () => {
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
        // id は source 配列の index ベース (= 不正要素を skip しても、 残った要素の id は drift しない)。
        // これにより metadata 編集で middle 要素を入れ替えても、 既存 reveal 記録の id は保たれる。
        hints: [
          { id: "hint-1", content: "use AWS Console", penalty: 0 },
          { id: "hint-3", content: "second hint", penalty: 0 },
        ],
      });
    });

    it("[#742 Phase 1, v2] hints が ProgressiveHint object array なら id / content / penalty を保持", () => {
      expect(
        parseScoringMetadata({
          kind: "flag",
          flagOutputKey: "X",
          points: 100,
          hints: [
            { id: "hint-1", content: "AWS Console で読む", penalty: 10 },
            { id: "hint-2", content: "値は `Hello from tc-...`", penalty: 20 },
          ],
        }),
      ).toEqual({
        kind: "flag",
        flagOutputKey: "X",
        points: 100,
        hints: [
          { id: "hint-1", content: "AWS Console で読む", penalty: 10 },
          { id: "hint-2", content: "値は `Hello from tc-...`", penalty: 20 },
        ],
      });
    });

    it("[#742 Phase 1, v2] penalty が不正値 (= negative / NaN / 文字列) なら 0 にクランプ", () => {
      const result = parseScoringMetadata({
        kind: "flag",
        flagOutputKey: "X",
        points: 100,
        hints: [
          { id: "h1", content: "a", penalty: -5 },
          { id: "h2", content: "b", penalty: "10" },
          { id: "h3", content: "c", penalty: Number.NaN },
          { id: "h4", content: "d", penalty: 7.9 },
        ],
      });
      expect(result?.kind).toBe("flag");
      if (result?.kind !== "flag") return;
      expect(result.hints).toEqual([
        { id: "h1", content: "a", penalty: 0 },
        { id: "h2", content: "b", penalty: 0 },
        { id: "h3", content: "c", penalty: 0 },
        { id: "h4", content: "d", penalty: 7 }, // 7.9 → floor → 7
      ]);
    });

    it("[#742 Phase 1] v1 と v2 の混在も許容 (= migration 途中の metadata でも壊れない)", () => {
      const result = parseScoringMetadata({
        kind: "flag",
        flagOutputKey: "X",
        points: 100,
        hints: ["legacy string hint", { id: "modern-hint", content: "new shape", penalty: 15 }],
      });
      expect(result?.kind).toBe("flag");
      if (result?.kind !== "flag") return;
      expect(result.hints).toEqual([
        { id: "hint-1", content: "legacy string hint", penalty: 0 },
        { id: "modern-hint", content: "new shape", penalty: 15 },
      ]);
    });

    it("[#742 Phase 1] v2 object に id / content が欠けていれば skip (= partial 不正でも全体 reject しない)", () => {
      const result = parseScoringMetadata({
        kind: "flag",
        flagOutputKey: "X",
        points: 100,
        hints: [
          { id: "ok", content: "valid", penalty: 5 },
          { content: "missing id" },
          { id: "missing-content" },
          { id: "", content: "empty id", penalty: 0 },
          { id: "empty-content", content: "", penalty: 0 },
        ],
      });
      expect(result?.kind).toBe("flag");
      if (result?.kind !== "flag") return;
      expect(result.hints).toEqual([{ id: "ok", content: "valid", penalty: 5 }]);
    });

    it("[#742 Phase 1] hints が空配列 / 不正な要素のみなら undefined を返す", () => {
      const r1 = parseScoringMetadata({ kind: "flag", flagOutputKey: "X", points: 1, hints: [] });
      expect(r1?.kind).toBe("flag");
      if (r1?.kind !== "flag") return;
      expect(r1.hints).toBeUndefined();

      const r2 = parseScoringMetadata({
        kind: "flag",
        flagOutputKey: "X",
        points: 1,
        hints: [123, null, undefined],
      });
      if (r2?.kind !== "flag") return;
      expect(r2.hints).toBeUndefined();
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

  describe("[#742 Phase 5] hints は全 5 kind に共通拡張", () => {
    it("uptime-flat kind should accept hints and normalize them to ProgressiveHint[]", () => {
      const result = parseScoringMetadata({
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
        hints: [{ id: "h1", content: "first endpoint", penalty: 5 }],
      });
      expect(result?.kind).toBe("uptime-flat");
      if (result?.kind !== "uptime-flat") return;
      expect(result.hints).toEqual([{ id: "h1", content: "first endpoint", penalty: 5 }]);
    });

    it("uptime-multi kind should accept hints (v1 legacy works too)", () => {
      const result = parseScoringMetadata({
        kind: "uptime-multi",
        probedSlots: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsAllOk: 100,
        hints: ["legacy hint"],
      });
      expect(result?.kind).toBe("uptime-multi");
      if (result?.kind !== "uptime-multi") return;
      expect(result.hints).toEqual([{ id: "hint-1", content: "legacy hint", penalty: 0 }]);
    });

    it("phased-polling kind should accept hints", () => {
      const result = parseScoringMetadata({
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100 } },
        hints: [{ id: "phase-hint", content: "migrate to lambda first", penalty: 50 }],
      });
      expect(result?.kind).toBe("phased-polling");
      if (result?.kind !== "phased-polling") return;
      expect(result.hints).toEqual([
        { id: "phase-hint", content: "migrate to lambda first", penalty: 50 },
      ]);
    });

    it("attack-detection kind should accept hints", () => {
      const result = parseScoringMetadata({
        kind: "attack-detection",
        statsOutputKey: "AttackCount",
        pointsPerAttack: 10,
        hints: [{ id: "attack-hint", content: "watch WAF logs", penalty: 5 }],
      });
      expect(result?.kind).toBe("attack-detection");
      if (result?.kind !== "attack-detection") return;
      expect(result.hints).toEqual([{ id: "attack-hint", content: "watch WAF logs", penalty: 5 }]);
    });

    it("hints を持たない既存 problem (= 全 4 kind) は touch されない", () => {
      const uf = parseScoringMetadata({
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      });
      expect(uf?.kind).toBe("uptime-flat");
      if (uf?.kind !== "uptime-flat") return;
      expect(uf.hints).toBeUndefined();
    });
  });

  describe("uptime 形式 (legacy alias of uptime-flat)", () => {
    it("should narrow when endpoints is an array and pointsPerSuccess is a number", () => {
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

  describe("uptime-flat 形式 (ADR-012 Phase 3.B 新名)", () => {
    it("should narrow slot-based endpoints", () => {
      const cfg = {
        kind: "uptime-flat",
        endpoints: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      };
      expect(parseScoringMetadata(cfg)).toEqual(cfg);
    });

    it("should drop endpoints lacking both slot and outputKey", () => {
      expect(
        parseScoringMetadata({
          kind: "uptime-flat",
          endpoints: [{ path: "/", expectStatus: [200] }],
          pointsPerSuccess: 50,
        }),
      ).toBeUndefined();
    });
  });

  describe("uptime-multi 形式", () => {
    it("should narrow when probedSlots + pointsAllOk are both set", () => {
      const cfg = {
        kind: "uptime-multi",
        probedSlots: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsAllOk: 100,
        failurePenalty: -50,
      };
      expect(parseScoringMetadata(cfg)).toEqual(cfg);
    });

    it("probedSlots が空 / pointsAllOk が無いと undefined", () => {
      expect(
        parseScoringMetadata({ kind: "uptime-multi", probedSlots: [], pointsAllOk: 100 }),
      ).toBeUndefined();
      expect(
        parseScoringMetadata({
          kind: "uptime-multi",
          probedSlots: [{ slot: "x", path: "/", expectStatus: [200] }],
        }),
      ).toBeUndefined();
    });
  });

  describe("phased-polling 形式", () => {
    it("should narrow when intervalMinutes + probe + platformRules are all set", () => {
      const cfg = {
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100, degradedPoints: 10 }, lambda: { points: 1000 } },
        failurePenalty: -100,
        responsePenalties: [{ if: "responseTimeMs > 1500", points: -10 }],
        bonuses: [
          {
            kind: "all-slots-on-platforms",
            platforms: ["lambda"],
            points: 5000,
            once: true,
          },
        ],
      };
      expect(parseScoringMetadata(cfg)).toEqual(cfg);
    });

    it("platformRules が空オブジェクトなら undefined", () => {
      expect(
        parseScoringMetadata({
          kind: "phased-polling",
          intervalMinutes: 1,
          probe: { metaPath: "/meta", scorePath: "/score" },
          platformRules: {},
        }),
      ).toBeUndefined();
    });

    it("probe.metaPath / scorePath が string でないと undefined", () => {
      expect(
        parseScoringMetadata({
          kind: "phased-polling",
          intervalMinutes: 1,
          probe: { metaPath: 123, scorePath: "/score" },
          platformRules: { ec2: { points: 100 } },
        }),
      ).toBeUndefined();
    });
  });

  describe("attack-detection 形式", () => {
    it("should narrow when statsOutputKey + pointsPerAttack are both set", () => {
      const cfg = {
        kind: "attack-detection",
        statsOutputKey: "AttackCounter",
        pointsPerAttack: 50,
        categories: [{ name: "sql-injection", pointsPerAttack: 100 }],
      };
      expect(parseScoringMetadata(cfg)).toEqual(cfg);
    });

    it("statsOutputKey 無し / pointsPerAttack が 0 以下なら undefined", () => {
      expect(
        parseScoringMetadata({ kind: "attack-detection", pointsPerAttack: 50 }),
      ).toBeUndefined();
      expect(
        parseScoringMetadata({
          kind: "attack-detection",
          statsOutputKey: "X",
          pointsPerAttack: 0,
        }),
      ).toBeUndefined();
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
    ])("should return undefined for %s", (input) => {
      expect(parseScoringMetadata(input)).toBeUndefined();
    });
  });
});

describe("parseScoringEnv", () => {
  it("should return an empty map for undefined / empty string / broken JSON", () => {
    expect(parseScoringEnv(undefined)).toEqual({});
    expect(parseScoringEnv("")).toEqual({});
    expect(parseScoringEnv("{not-json")).toEqual({});
  });

  it("should return an empty map for arrays or primitives", () => {
    expect(parseScoringEnv(JSON.stringify(["x"]))).toEqual({});
    expect(parseScoringEnv(JSON.stringify(123))).toEqual({});
  });

  it("should pick up only the valid entries in a mixed set", () => {
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
