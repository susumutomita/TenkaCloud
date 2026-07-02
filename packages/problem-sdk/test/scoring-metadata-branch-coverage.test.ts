/**
 * Issue #2225 follow-up: the scoring-metadata split moved every kind's parser
 * into its own file, which exposed pre-existing partial-branch gaps as "new"
 * diff lines for codecov/patch (the aggregate coverage is unchanged from
 * before the split — see the PR body). These tests exercise the previously
 * untested branch permutations directly against each kind module.
 */
import { describe, expect, it } from "vitest";
import { parseAttackDetection } from "../src/scoring-metadata/attack-detection.js";
import { parseCompositeProbe } from "../src/scoring-metadata/composite.js";
import { parseFlag } from "../src/scoring-metadata/flag.js";
import { clampWrongAnswerPenalty, parseHints } from "../src/scoring-metadata/hints.js";
import { parseMultiFlag } from "../src/scoring-metadata/multi-flag.js";
import { parseMultiVerify } from "../src/scoring-metadata/multi-verify.js";
import { parsePhasedPolling } from "../src/scoring-metadata/phased-polling.js";
import {
  isPositiveNumber,
  optionalNonEmptyString,
  parseExpectedStatuses,
} from "../src/scoring-metadata/primitives.js";
import { parseUptimeFlat, parseUptimeMulti } from "../src/scoring-metadata/uptime.js";

describe("primitives", () => {
  it("isPositiveNumber: false for zero / negative / non-number", () => {
    expect(isPositiveNumber(0)).toBe(false);
    expect(isPositiveNumber(-1)).toBe(false);
    expect(isPositiveNumber("1")).toBe(false);
    expect(isPositiveNumber(1)).toBe(true);
  });

  it("optionalNonEmptyString: undefined for empty / non-string", () => {
    expect(optionalNonEmptyString("")).toBeUndefined();
    expect(optionalNonEmptyString(42)).toBeUndefined();
    expect(optionalNonEmptyString("x")).toBe("x");
  });

  it("parseExpectedStatuses: undefined for empty / non-array / all-non-number", () => {
    expect(parseExpectedStatuses([])).toBeUndefined();
    expect(parseExpectedStatuses("200")).toBeUndefined();
    expect(parseExpectedStatuses(["200"])).toBeUndefined();
    expect(parseExpectedStatuses([200, "204"])).toEqual([200]);
  });
});

describe("hints", () => {
  it("clampWrongAnswerPenalty: undefined for negative / non-integer / non-number", () => {
    expect(clampWrongAnswerPenalty(-1)).toBeUndefined();
    expect(clampWrongAnswerPenalty(1.5)).toBeUndefined();
    expect(clampWrongAnswerPenalty("1")).toBeUndefined();
    expect(clampWrongAnswerPenalty(0)).toBe(0);
  });

  it("parseHints: undefined for non-array, filters invalid entries, undefined when all invalid", () => {
    expect(parseHints("not-array")).toBeUndefined();
    expect(parseHints([{ id: "", content: "x" }])).toBeUndefined();
    expect(parseHints([{ id: "h1", content: "" }])).toBeUndefined();
    expect(parseHints([42])).toBeUndefined();
    expect(parseHints(["legacy", { id: "h2", content: "c", penalty: -5 }])).toEqual([
      { id: "hint-1", content: "legacy", penalty: 0 },
      { id: "h2", content: "c", penalty: 0 },
    ]);
    expect(parseHints([{ id: "h1", content: "c", penalty: 2.9 }])?.[0]?.penalty).toBe(2);
  });
});

describe("flag", () => {
  it("parseFlag: undefined for non-string key or non-finite/negative points", () => {
    expect(parseFlag({ flagOutputKey: 1, points: 5 })).toBeUndefined();
    expect(parseFlag({ flagOutputKey: "k", points: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(parseFlag({ flagOutputKey: "k", points: -1 })).toBeUndefined();
  });
});

describe("multi-flag", () => {
  it("parseMultiFlag: rejects a non-object entry and a non-finite points entry", () => {
    expect(parseMultiFlag({ flags: ["not-object"] })).toBeUndefined();
    expect(
      parseMultiFlag({
        flags: [{ id: "a", label: "A", flagOutputKey: "k", points: Number.NaN }],
      }),
    ).toBeUndefined();
    expect(
      parseMultiFlag({
        flags: [{ id: "a", label: "", flagOutputKey: "k", points: 1 }],
      }),
    ).toBeUndefined();
  });

  it("parseMultiFlag: keeps hints when present on an entry", () => {
    const result = parseMultiFlag({
      flags: [{ id: "a", label: "A", flagOutputKey: "k", points: 1, hints: ["h"] }],
    });
    expect(result?.flags[0]?.hints).toHaveLength(1);
  });
});

describe("multi-verify", () => {
  it("parseMultiVerify: accepts a check without hints (undefined branch)", () => {
    const result = parseMultiVerify({
      checks: [
        { id: "c1", label: "A", points: 1 },
        { id: "c2", label: "B", points: 1 },
      ],
    });
    expect(result?.checks).toHaveLength(2);
  });
});

describe("uptime-flat", () => {
  it("parseUptimeFlat: accepts an endpoint carrying both slot and outputKey", () => {
    const result = parseUptimeFlat(
      {
        endpoints: [{ slot: "web", outputKey: "Url", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 5,
      },
      "uptime-flat",
    );
    expect(result?.endpoints[0]).toMatchObject({ slot: "web", outputKey: "Url" });
  });

  it("parseUptimeFlat: drops an endpoint missing path/expectStatus and rejects when all endpoints drop", () => {
    expect(
      parseUptimeFlat(
        { endpoints: [{ path: 42, expectStatus: [200] }], pointsPerSuccess: 5 },
        "uptime-flat",
      ),
    ).toBeUndefined();
    expect(
      parseUptimeFlat(
        { endpoints: [{ path: "/", expectStatus: [] }], pointsPerSuccess: 5 },
        "uptime-flat",
      ),
    ).toBeUndefined();
    expect(
      parseUptimeFlat(
        { endpoints: [{ slot: "web", path: "/" }], pointsPerSuccess: 5 },
        "uptime-flat",
      ),
    ).toBeUndefined();
  });

  it("parseUptimeFlat: rejects a non-array/empty endpoints list or non-positive pointsPerSuccess", () => {
    expect(parseUptimeFlat({ endpoints: [], pointsPerSuccess: 5 }, "uptime-flat")).toBeUndefined();
    expect(
      parseUptimeFlat(
        { endpoints: [{ path: "/", expectStatus: [200] }], pointsPerSuccess: 0 },
        "uptime-flat",
      ),
    ).toBeUndefined();
  });

  it("parseUptimeFlat: omits failurePenalty and hints when absent", () => {
    const result = parseUptimeFlat(
      { endpoints: [{ slot: "web", path: "/", expectStatus: [200] }], pointsPerSuccess: 5 },
      "uptime-flat",
    );
    expect(result && "failurePenalty" in result).toBe(false);
    expect(result && "hints" in result).toBe(false);
  });
});

describe("uptime-multi", () => {
  it("parseUptimeMulti: rejects a non-array/empty probedSlots or non-positive pointsAllOk", () => {
    expect(parseUptimeMulti({ probedSlots: [], pointsAllOk: 5 })).toBeUndefined();
    expect(
      parseUptimeMulti({
        probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
        pointsAllOk: 0,
      }),
    ).toBeUndefined();
  });

  it("parseUptimeMulti: drops a malformed slot and rejects when every slot drops", () => {
    expect(
      parseUptimeMulti({
        probedSlots: [{ slot: 1, path: "/", expectStatus: [200] }],
        pointsAllOk: 5,
      }),
    ).toBeUndefined();
    expect(
      parseUptimeMulti({
        probedSlots: [{ slot: "web", path: "/" }],
        pointsAllOk: 5,
      }),
    ).toBeUndefined();
  });

  it("parseUptimeMulti: omits attackProbes when the array is empty after filtering", () => {
    const result = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackProbes: "not-an-array",
    });
    expect(result && "attackProbes" in result).toBe(false);
  });

  it("parseUptimeMulti: drops a malformed attack-probe entry (missing slot/path/penalty/vulnerableStatus)", () => {
    const noSlot = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackProbes: [{ path: "/x", vulnerableStatus: [200], penalty: 1 }],
    });
    expect(noSlot && "attackProbes" in noSlot).toBe(false);

    const noPenalty = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackProbes: [{ slot: "web", path: "/x", penalty: 0, vulnerableStatus: [200] }],
    });
    expect(noPenalty && "attackProbes" in noPenalty).toBe(false);

    const noVulnerable = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackProbes: [{ slot: "web", path: "/x", penalty: 1, vulnerableStatus: "not-array" }],
    });
    expect(noVulnerable && "attackProbes" in noVulnerable).toBe(false);
  });

  it("parseUptimeMulti: keeps a GET attack-probe without a body", () => {
    const result = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackProbes: [
        { slot: "web", path: "/x", method: "GET", penalty: 1, vulnerableStatus: [200] },
      ],
    });
    expect(result && "attackProbes" in result && result.attackProbes?.[0]).toMatchObject({
      method: "GET",
    });
  });

  it("parseUptimeMulti: drops attackBlocked missing slot/path/pointsPerBlock", () => {
    const missingSlot = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackBlocked: { path: "/x", pointsPerBlock: 1 },
    });
    expect(missingSlot && "attackBlocked" in missingSlot).toBe(false);

    const missingPath = parseUptimeMulti({
      probedSlots: [{ slot: "web", path: "/", expectStatus: [200] }],
      pointsAllOk: 5,
      attackBlocked: { slot: "web", pointsPerBlock: 1 },
    });
    expect(missingPath && "attackBlocked" in missingPath).toBe(false);
  });
});

describe("phased-polling", () => {
  it("parsePhasedPolling: rejects a non-positive interval, missing probe, or empty platformRules", () => {
    expect(
      parsePhasedPolling({
        intervalMinutes: 0,
        probe: { metaPath: "/m", scorePath: "/s" },
        platformRules: { aws: { points: 1 } },
      }),
    ).toBeUndefined();
    expect(
      parsePhasedPolling({
        intervalMinutes: 5,
        probe: { metaPath: "/m" },
        platformRules: { aws: { points: 1 } },
      }),
    ).toBeUndefined();
    expect(
      parsePhasedPolling({
        intervalMinutes: 5,
        probe: { metaPath: "/m", scorePath: "/s" },
        platformRules: {},
      }),
    ).toBeUndefined();
  });

  it("parsePhasedPolling: rejects a probe with a non-string posturePath", () => {
    expect(
      parsePhasedPolling({
        intervalMinutes: 5,
        probe: { metaPath: "/m", scorePath: "/s", posturePath: 42 },
        platformRules: { aws: { points: 1 } },
      }),
    ).toBeUndefined();
  });

  it("parsePhasedPolling: drops a platform rule with non-number points and a non-number degradedPoints", () => {
    const result = parsePhasedPolling({
      intervalMinutes: 5,
      probe: { metaPath: "/m", scorePath: "/s" },
      platformRules: {
        aws: { points: 1, degradedPoints: "bad" },
        bad: { points: "not-a-number" },
        gcp: "not-an-object",
      },
    });
    expect(result?.platformRules).toEqual({ aws: { points: 1 } });
  });

  it("parsePhasedPolling: drops malformed responsePenalties/bonuses entries and omits empty arrays", () => {
    const result = parsePhasedPolling({
      intervalMinutes: 5,
      probe: { metaPath: "/m", scorePath: "/s" },
      platformRules: { aws: { points: 1 } },
      responsePenalties: "not-an-array",
      bonuses: [
        "not-an-object",
        { kind: "b", points: 1, once: "not-boolean", platforms: "not-array" },
      ],
    });
    expect(result && "responsePenalties" in result).toBe(false);
    expect(result?.bonuses).toEqual([{ kind: "b", points: 1 }]);
  });

  it("parsePhasedPolling: keeps a response penalty and a bonus with once/platforms", () => {
    const result = parsePhasedPolling({
      intervalMinutes: 5,
      probe: { metaPath: "/m", scorePath: "/s" },
      platformRules: { aws: { points: 1 } },
      responsePenalties: [{ if: "responseTimeMs > 500", points: -1 }, "bad"],
      bonuses: [{ kind: "b", points: 1, once: true, platforms: ["aws", 42] }],
    });
    expect(result?.responsePenalties).toHaveLength(1);
    expect(result?.bonuses?.[0]).toMatchObject({ once: true, platforms: ["aws"] });
  });
});

describe("attack-detection", () => {
  it("parseAttackDetection: rejects a missing statsOutputKey or non-positive pointsPerAttack", () => {
    expect(parseAttackDetection({ statsOutputKey: "", pointsPerAttack: 1 })).toBeUndefined();
    expect(parseAttackDetection({ statsOutputKey: "k", pointsPerAttack: 0 })).toBeUndefined();
  });

  it("parseAttackDetection: drops a malformed category and omits categories when the array is empty", () => {
    const result = parseAttackDetection({
      statsOutputKey: "k",
      pointsPerAttack: 1,
      categories: ["not-an-object", { name: 42 }],
    });
    expect(result && "categories" in result).toBe(false);
  });

  it("parseAttackDetection: keeps a category without pointsPerAttack", () => {
    const result = parseAttackDetection({
      statsOutputKey: "k",
      pointsPerAttack: 1,
      categories: [{ name: "sqli" }],
    });
    expect(result?.categories).toEqual([{ name: "sqli" }]);
  });
});

describe("composite-probe", () => {
  it("parseCompositeProbe: rejects success !== 'all', non-positive pointsAllOk, or empty targets", () => {
    expect(
      parseCompositeProbe({ success: "any", pointsAllOk: 1, targets: [{ targetId: "a" }] }),
    ).toBeUndefined();
    expect(
      parseCompositeProbe({ success: "all", pointsAllOk: 0, targets: [{ targetId: "a" }] }),
    ).toBeUndefined();
    expect(parseCompositeProbe({ success: "all", pointsAllOk: 1, targets: [] })).toBeUndefined();
  });

  it("parseCompositeProbe: drops a target missing targetId/outputKey/probe", () => {
    expect(
      parseCompositeProbe({
        success: "all",
        pointsAllOk: 1,
        targets: [{ probe: "https", outputKey: "Url" }],
      }),
    ).toBeUndefined();
    expect(
      parseCompositeProbe({
        success: "all",
        pointsAllOk: 1,
        targets: [{ targetId: "a", probe: "ftp", outputKey: "Url" }],
      }),
    ).toBeUndefined();
  });

  it("parseCompositeProbe: keeps a target without an optional path/expectStatus", () => {
    const result = parseCompositeProbe({
      success: "all",
      pointsAllOk: 1,
      targets: [{ targetId: "a", probe: "https", outputKey: "Url" }],
    });
    expect(result?.targets[0]).toEqual({ targetId: "a", probe: "https", outputKey: "Url" });
  });
});
