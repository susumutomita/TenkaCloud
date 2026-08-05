/**
 * [Problem SDK / Issue #2106] Direct unit tests for the pure scoring-metadata
 * parser. The parser is the durable public scoring contract, so it is exercised
 * here in its own right — every supported kind plus its malformed branches.
 */

import { describe, expect, it } from "vitest";
import { parseHintRevealMode } from "../src/scoring-metadata/hints.js";
import { parseScoringMetadata } from "../src/scoring-metadata.js";

describe("parseScoringMetadata: non-object / unknown kind", () => {
  it("should reject non-object and unknown-kind input", () => {
    expect(parseScoringMetadata(undefined)).toBeUndefined();
    expect(parseScoringMetadata(null)).toBeUndefined();
    expect(parseScoringMetadata("flag")).toBeUndefined();
    expect(parseScoringMetadata({})).toBeUndefined();
    expect(parseScoringMetadata({ kind: "not-a-real-kind" })).toBeUndefined();
  });
});

describe("parseScoringMetadata: flag", () => {
  it("should parse a minimal flag", () => {
    expect(parseScoringMetadata({ kind: "flag", flagOutputKey: "Flag", points: 100 })).toEqual({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      wrongAnswerPenalty: undefined,
      hints: undefined,
    });
  });

  it("should reject a flag with a missing key or non-positive points", () => {
    expect(parseScoringMetadata({ kind: "flag", points: 100 })).toBeUndefined();
    expect(
      parseScoringMetadata({ kind: "flag", flagOutputKey: "Flag", points: 0 }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({ kind: "flag", flagOutputKey: "Flag", points: Number.NaN }),
    ).toBeUndefined();
  });

  it("should keep a valid wrongAnswerPenalty and drop an invalid one", () => {
    const ok = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      wrongAnswerPenalty: 5,
    });
    expect(ok).toMatchObject({ wrongAnswerPenalty: 5 });
    const dropped = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      wrongAnswerPenalty: -1,
    });
    expect(dropped).toMatchObject({ wrongAnswerPenalty: undefined });
  });

  it("should normalize legacy string hints and v2 object hints", () => {
    const legacy = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      hints: ["first", "second"],
    });
    expect(legacy?.kind === "flag" && legacy.hints).toEqual([
      { id: "hint-1", content: "first", penalty: 0 },
      { id: "hint-2", content: "second", penalty: 0 },
    ]);
    const v2 = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      hints: [{ id: "h1", content: "x", penalty: 3.9 }, { content: "no-id" }],
    });
    expect(v2?.kind === "flag" && v2.hints).toEqual([{ id: "h1", content: "x", penalty: 3 }]);
  });
});

describe("parseHintRevealMode: hint unlock order (flat vs sequential)", () => {
  it("should honor the two literals and default everything else to undefined", () => {
    expect(parseHintRevealMode("flat")).toBe("flat");
    expect(parseHintRevealMode("sequential")).toBe("sequential");
    // Absent / typo / wrong type all resolve to undefined (= sequential default).
    expect(parseHintRevealMode(undefined)).toBeUndefined();
    expect(parseHintRevealMode("FLAT")).toBeUndefined();
    expect(parseHintRevealMode("ordered")).toBeUndefined();
    expect(parseHintRevealMode(1)).toBeUndefined();
    expect(parseHintRevealMode(null)).toBeUndefined();
  });

  it("should carry hintReveal on a flag problem, defaulting to undefined", () => {
    const flat = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      hintReveal: "flat",
    });
    expect(flat).toMatchObject({ kind: "flag", hintReveal: "flat" });
    const unset = parseScoringMetadata({ kind: "flag", flagOutputKey: "Flag", points: 100 });
    expect(unset?.kind === "flag" && unset.hintReveal).toBeUndefined();
    const bogus = parseScoringMetadata({
      kind: "flag",
      flagOutputKey: "Flag",
      points: 100,
      hintReveal: "nope",
    });
    expect(bogus?.kind === "flag" && bogus.hintReveal).toBeUndefined();
  });

  it("should carry a top-level hintReveal on a multi-verify problem", () => {
    const flat = parseScoringMetadata({
      kind: "multi-verify",
      hintReveal: "flat",
      checks: [
        { id: "a", label: "A", points: 50 },
        { id: "b", label: "B", points: 50 },
      ],
    });
    expect(flat).toMatchObject({ kind: "multi-verify", hintReveal: "flat" });
    // Unset omits the key entirely (kept minimal, unlike the always-present flag field).
    const unset = parseScoringMetadata({
      kind: "multi-verify",
      checks: [
        { id: "a", label: "A", points: 50 },
        { id: "b", label: "B", points: 50 },
      ],
    });
    expect(unset && "hintReveal" in unset).toBe(false);
  });
});

describe("parseScoringMetadata: multi-flag", () => {
  it("should parse independent flags", () => {
    const result = parseScoringMetadata({
      kind: "multi-flag",
      flags: [
        { id: "a", label: "A", flagOutputKey: "FlagA", points: 10 },
        { id: "b", label: "B", flagOutputKey: "FlagB", points: 20 },
      ],
    });
    expect(result?.kind).toBe("multi-flag");
    expect(result && "flags" in result && result.flags).toHaveLength(2);
  });

  it("should reject an empty list, an invalid entry, or duplicate ids/keys", () => {
    expect(parseScoringMetadata({ kind: "multi-flag", flags: [] })).toBeUndefined();
    expect(
      parseScoringMetadata({ kind: "multi-flag", flags: [{ id: "a", label: "A" }] }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "multi-flag",
        flags: [
          { id: "a", label: "A", flagOutputKey: "FlagA", points: 10 },
          { id: "a", label: "B", flagOutputKey: "FlagB", points: 20 },
        ],
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "multi-flag",
        flags: [
          { id: "a", label: "A", flagOutputKey: "Same", points: 10 },
          { id: "b", label: "B", flagOutputKey: "Same", points: 20 },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("parseScoringMetadata: uptime-flat", () => {
  it("should parse uptime-flat (and the legacy `uptime` alias)", () => {
    const flat = parseScoringMetadata({
      kind: "uptime-flat",
      pointsPerSuccess: 10,
      endpoints: [{ slot: "web", path: "/health", expectStatus: [200], pointsPerSuccess: 5 }],
      failurePenalty: -3,
    });
    expect(flat?.kind).toBe("uptime-flat");
    const legacy = parseScoringMetadata({
      kind: "uptime",
      pointsPerSuccess: 10,
      endpoints: [{ outputKey: "Url", path: "/", expectStatus: [200, 204] }],
    });
    expect(legacy?.kind).toBe("uptime");
  });

  it("should reject when endpoints are empty, points non-positive, or no slot/outputKey", () => {
    expect(
      parseScoringMetadata({ kind: "uptime-flat", pointsPerSuccess: 10, endpoints: [] }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "uptime-flat",
        pointsPerSuccess: 0,
        endpoints: [{ slot: "web", path: "/", expectStatus: [200] }],
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "uptime-flat",
        pointsPerSuccess: 10,
        endpoints: [{ path: "/", expectStatus: [200] }],
      }),
    ).toBeUndefined();
  });
});

describe("parseScoringMetadata: uptime-multi", () => {
  it("should parse probed slots with optional attackBlocked / attackProbes", () => {
    const result = parseScoringMetadata({
      kind: "uptime-multi",
      pointsAllOk: 50,
      probedSlots: [{ slot: "web", path: "/health", expectStatus: [200] }],
      failurePenalty: -10,
      attackBlocked: { slot: "web", path: "/blocked", pointsPerBlock: 2 },
      attackProbes: [
        {
          slot: "web",
          path: "/sqli",
          method: "POST",
          body: "x",
          vulnerableStatus: [200],
          penalty: 5,
        },
      ],
    });
    expect(result?.kind).toBe("uptime-multi");
    expect(result && "attackBlocked" in result && result.attackBlocked).toBeDefined();
    expect(result && "attackProbes" in result && result.attackProbes).toHaveLength(1);
  });

  it("[#2422] should parse the optional non-spoiler label / symptom on an attack-probe", () => {
    const result = parseScoringMetadata({
      kind: "uptime-multi",
      pointsAllOk: 50,
      probedSlots: [{ slot: "web", path: "/health", expectStatus: [200] }],
      attackProbes: [
        {
          slot: "web",
          path: "/sqli",
          vulnerableStatus: [200],
          penalty: 5,
          label: "  SQLi auth-bypass probe  ",
          symptom: "  still returns 200 to the crafted login  ",
        },
      ],
    });
    const probe = result?.kind === "uptime-multi" ? result.attackProbes?.[0] : undefined;
    expect(probe?.label).toBe("SQLi auth-bypass probe"); // trimmed
    expect(probe?.symptom).toBe("still returns 200 to the crafted login"); // trimmed
  });

  it("[#2422] should drop a blank label / symptom and cap over-long values", () => {
    const result = parseScoringMetadata({
      kind: "uptime-multi",
      pointsAllOk: 50,
      probedSlots: [{ slot: "web", path: "/health", expectStatus: [200] }],
      attackProbes: [
        {
          slot: "web",
          path: "/sqli",
          vulnerableStatus: [200],
          penalty: 5,
          label: "   ", // blank → dropped
          symptom: "s".repeat(200), // capped at 160
        },
      ],
    });
    const probe = result?.kind === "uptime-multi" ? result.attackProbes?.[0] : undefined;
    expect(probe && "label" in probe).toBe(false);
    expect(probe?.symptom).toHaveLength(160);
  });

  it("should reject empty probedSlots or non-positive points and drop a bad attack section", () => {
    expect(
      parseScoringMetadata({ kind: "uptime-multi", pointsAllOk: 50, probedSlots: [] }),
    ).toBeUndefined();
    const droppedAttack = parseScoringMetadata({
      kind: "uptime-multi",
      pointsAllOk: 50,
      probedSlots: [{ slot: "web", path: "/health", expectStatus: [200] }],
      attackBlocked: { slot: "web", path: "/x", pointsPerBlock: 0 },
    });
    expect(droppedAttack?.kind).toBe("uptime-multi");
    expect(droppedAttack && "attackBlocked" in droppedAttack).toBe(false);
  });
});

describe("parseScoringMetadata: phased-polling", () => {
  it("should parse a phased-polling config with platform rules and bonuses", () => {
    const result = parseScoringMetadata({
      kind: "phased-polling",
      intervalMinutes: 5,
      probe: { metaPath: "/meta", scorePath: "/score", posturePath: "/posture" },
      platformRules: { aws: { points: 100, degradedPoints: 50 } },
      failurePenalty: -5,
      responsePenalties: [{ if: "responseTimeMs > 1000", points: -2 }],
      bonuses: [{ kind: "all-slots-on-platforms", points: 25, once: true, platforms: ["aws"] }],
    });
    expect(result?.kind).toBe("phased-polling");
  });

  it("should reject when the interval, probe, or platform rules are missing", () => {
    expect(parseScoringMetadata({ kind: "phased-polling", intervalMinutes: 0 })).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "phased-polling",
        intervalMinutes: 5,
        probe: { metaPath: "/m" },
        platformRules: { aws: { points: 1 } },
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "phased-polling",
        intervalMinutes: 5,
        probe: { metaPath: "/m", scorePath: "/s" },
        platformRules: {},
      }),
    ).toBeUndefined();
  });
});

describe("parseScoringMetadata: attack-detection", () => {
  it("should parse attack-detection with optional categories", () => {
    const result = parseScoringMetadata({
      kind: "attack-detection",
      statsOutputKey: "Stats",
      pointsPerAttack: 3,
      categories: [{ name: "sqli", pointsPerAttack: 5 }, { name: "xss" }],
    });
    expect(result?.kind).toBe("attack-detection");
    expect(result && "categories" in result && result.categories).toHaveLength(2);
  });

  it("should reject a missing stats key or non-positive points", () => {
    expect(parseScoringMetadata({ kind: "attack-detection", pointsPerAttack: 3 })).toBeUndefined();
    expect(
      parseScoringMetadata({ kind: "attack-detection", statsOutputKey: "S", pointsPerAttack: 0 }),
    ).toBeUndefined();
  });
});

describe("parseScoringMetadata: composite-probe", () => {
  it("should parse a composite-probe with all targets", () => {
    const result = parseScoringMetadata({
      kind: "composite-probe",
      success: "all",
      pointsAllOk: 100,
      targets: [
        {
          targetId: "fe",
          probe: "https",
          outputKey: "FeUrl",
          path: "/health",
          expectStatus: [200],
        },
        { targetId: "be", probe: "https", outputKey: "BeUrl" },
      ],
    });
    expect(result?.kind).toBe("composite-probe");
    expect(result && "targets" in result && result.targets).toHaveLength(2);
  });

  it("should reject non-all success, empty targets, bad probe, or duplicate targetId", () => {
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "any",
        pointsAllOk: 1,
        targets: [],
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 0,
        targets: [],
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 1,
        targets: [{ targetId: "fe", probe: "ftp", outputKey: "Url" }],
      }),
    ).toBeUndefined();
    expect(
      parseScoringMetadata({
        kind: "composite-probe",
        success: "all",
        pointsAllOk: 1,
        targets: [
          { targetId: "x", probe: "https", outputKey: "A" },
          { targetId: "x", probe: "https", outputKey: "B" },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("parseScoringMetadata: multi-verify (issue #2252)", () => {
  const validCheck = (over: Record<string, unknown> = {}) => ({
    id: "public-backup",
    label: "公開バックアップ",
    points: 50,
    ...over,
  });
  const secondCheck = (over: Record<string, unknown> = {}) => ({
    id: "exposed-config",
    label: "設定ファイルの控え",
    points: 50,
    ...over,
  });
  // The contract requires 2–8 checks, so the minimal valid fixture has two.
  const valid = (checks: unknown[] = [validCheck(), secondCheck()]) => ({
    kind: "multi-verify",
    checks,
  });

  it("should parse a minimal multi-verify with two checks", () => {
    expect(parseScoringMetadata(valid())).toEqual({
      kind: "multi-verify",
      checks: [
        {
          id: "public-backup",
          label: "公開バックアップ",
          points: 50,
          wrongAnswerPenalty: undefined,
        },
        {
          id: "exposed-config",
          label: "設定ファイルの控え",
          points: 50,
          wrongAnswerPenalty: undefined,
        },
      ],
    });
  });

  it("should carry wrongAnswerPenalty and per-check hints", () => {
    const parsed = parseScoringMetadata(
      valid([
        validCheck({
          wrongAnswerPenalty: 5,
          hints: [{ id: "location", content: "公開パスを確認する", penalty: 0 }],
        }),
        secondCheck(),
      ]),
    );
    expect(parsed).toEqual({
      kind: "multi-verify",
      checks: [
        {
          id: "public-backup",
          label: "公開バックアップ",
          points: 50,
          wrongAnswerPenalty: 5,
          hints: [{ id: "location", content: "公開パスを確認する", penalty: 0 }],
        },
        {
          id: "exposed-config",
          label: "設定ファイルの控え",
          points: 50,
          wrongAnswerPenalty: undefined,
        },
      ],
    });
  });

  it("should carry a valid Portal input shape and reject unknown shapes", () => {
    expect(
      parseScoringMetadata(valid([validCheck({ input: "multiline" }), secondCheck()])),
    ).toMatchObject({ checks: [{ input: "multiline" }, expect.any(Object)] });
    expect(
      parseScoringMetadata(valid([validCheck({ input: "rich-text" }), secondCheck()])),
    ).toBeUndefined();
  });

  it("should reject fewer than 2 or more than 8 checks (fail-closed)", () => {
    expect(parseScoringMetadata({ kind: "multi-verify", checks: [] })).toBeUndefined();
    expect(parseScoringMetadata({ kind: "multi-verify" })).toBeUndefined();
    expect(parseScoringMetadata(valid([validCheck()]))).toBeUndefined();
    const nine = Array.from({ length: 9 }, (_, i) => validCheck({ id: `c${i}` }));
    expect(parseScoringMetadata(valid(nine))).toBeUndefined();
  });

  it("should reject duplicate check ids (never partial-drop)", () => {
    expect(
      parseScoringMetadata(valid([validCheck(), validCheck({ label: "別ラベル" })])),
    ).toBeUndefined();
  });

  it("should reject ids that do not match ^[a-z0-9][a-z0-9-]{0,63}$", () => {
    for (const id of ["Public-Backup", "public_backup", "check 1", "", "-lead", "a".repeat(65)]) {
      expect(parseScoringMetadata(valid([validCheck({ id }), secondCheck()]))).toBeUndefined();
    }
  });

  it("should reject a label longer than 80 characters", () => {
    expect(
      parseScoringMetadata(valid([validCheck({ label: "あ".repeat(81) }), secondCheck()])),
    ).toBeUndefined();
  });

  it("should reject wrongAnswerPenalty greater than the check points", () => {
    expect(
      parseScoringMetadata(
        valid([validCheck({ points: 50, wrongAnswerPenalty: 51 }), secondCheck()]),
      ),
    ).toBeUndefined();
  });

  it("should reject non-positive / non-integer points (whole object, not the check)", () => {
    for (const points of [0, -10, 12.5, "50", Number.NaN]) {
      expect(parseScoringMetadata(valid([validCheck({ points }), secondCheck()]))).toBeUndefined();
    }
  });

  it("should reject a missing / empty label", () => {
    expect(parseScoringMetadata(valid([validCheck({ label: "" }), secondCheck()]))).toBeUndefined();
    expect(
      parseScoringMetadata(valid([validCheck({ label: undefined }), secondCheck()])),
    ).toBeUndefined();
  });

  it("should reject duplicate hint ids across the whole problem (reveal route keys on hintId)", () => {
    // Same hint id in two different checks — the flat reveal route is ambiguous.
    const parsed = parseScoringMetadata(
      valid([
        validCheck({ hints: [{ id: "shared", content: "a", penalty: 0 }] }),
        secondCheck({ hints: [{ id: "shared", content: "b", penalty: 0 }] }),
      ]),
    );
    expect(parsed).toBeUndefined();
  });

  it("should reject duplicate hint ids within one check (reveal records key on them)", () => {
    const parsed = parseScoringMetadata(
      valid([
        validCheck({
          hints: [
            { id: "h1", content: "a", penalty: 0 },
            { id: "h1", content: "b", penalty: 0 },
          ],
        }),
        secondCheck(),
      ]),
    );
    expect(parsed).toBeUndefined();
  });

  it("should reject one invalid check even when siblings are valid (total must not change)", () => {
    expect(parseScoringMetadata(valid([validCheck(), secondCheck({ points: 0 })]))).toBeUndefined();
  });
});
