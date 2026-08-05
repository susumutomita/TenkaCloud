import { describe, expect, it } from "vitest";
import { loadContainerProblem, type ManifestFs } from "../../../scripts/local-play/manifest";
import { parseScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * [#2252] multi-verify contract fixtures. The multi-verify structural contract
 * is enforced in THREE places that must never drift apart:
 *   1. the catalog SCHEMA.json + validate-problems.ts (TenkaCloudChallenge)
 *   2. the platform SDK parser        (packages/problem-sdk parseScoringMetadata)
 *   3. the local-play manifest loader  (scripts/local-play/manifest loadContainerProblem)
 *
 * This test pins (2) and (3) — the two platform parsers — to the SAME fixtures so
 * a problem valid for cloud discovery is also valid for `make local`, and both
 * reject the same malformed input. The fixtures below are the canonical contract;
 * the catalog validator's own test (scripts/validate-problems.test.ts) asserts the
 * identical rules on side (1) with the same numbers (2–8 checks, id
 * `^[a-z0-9][a-z0-9-]{0,63}$`, label ≤80, wrongAnswerPenalty ≤ points, hint ids
 * unique across the problem).
 */

const DIR = "/repo/problems/challenges/contract";
const BASE = {
  name: "Contract Fixture",
  description: "d",
  instructions: "i",
  runtime: {
    provider: "docker",
    engine: "compose",
    entry: "local/docker-compose.yml",
    challengeEndpoints: { Web: "http://127.0.0.1:18080" },
    verifyUrl: "http://127.0.0.1:18081/verify",
    secretEnv: ["FLAG_SEED"],
  },
};

function manifestParses(checks: unknown[]): boolean {
  const fs: ManifestFs = {
    existsSync: (p) => p === `${DIR}/metadata.json` || p === `${DIR}/local/docker-compose.yml`,
    readFileSync: (p) => {
      if (p === `${DIR}/metadata.json`) {
        return JSON.stringify({ ...BASE, scoring: { kind: "multi-verify", checks } });
      }
      if (p === `${DIR}/local/docker-compose.yml`) return "services: {}";
      throw new Error(`ENOENT: ${p}`);
    },
  };
  try {
    loadContainerProblem(DIR, fs);
    return true;
  } catch {
    return false;
  }
}

function sdkParses(checks: unknown[]): boolean {
  return parseScoringMetadata({ kind: "multi-verify", checks }) !== undefined;
}

const check = (over: Record<string, unknown> = {}) => ({
  id: "public-backup",
  label: "公開バックアップ",
  points: 50,
  ...over,
});
const check2 = (over: Record<string, unknown> = {}) => ({
  id: "exposed-config",
  label: "設定ファイルの控え",
  points: 50,
  ...over,
});

interface Fixture {
  readonly name: string;
  readonly checks: unknown[];
  readonly valid: boolean;
}

const FIXTURES: Fixture[] = [
  { name: "two minimal checks", checks: [check(), check2()], valid: true },
  {
    name: "eight checks (max)",
    checks: Array.from({ length: 8 }, (_, i) => check({ id: `c${i}` })),
    valid: true,
  },
  {
    name: "penalty equal to points + per-check hint",
    checks: [
      check({ wrongAnswerPenalty: 50, hints: [{ id: "h1", content: "a", penalty: 1 }] }),
      check2(),
    ],
    valid: true,
  },
  {
    name: "text and multiline Portal input shapes",
    checks: [check({ input: "multiline" }), check2({ input: "text" })],
    valid: true,
  },
  {
    name: "unknown Portal input shape",
    checks: [check({ input: "rich-text" }), check2()],
    valid: false,
  },
  { name: "one check (below min)", checks: [check()], valid: false },
  { name: "zero checks", checks: [], valid: false },
  {
    name: "nine checks (above max)",
    checks: Array.from({ length: 9 }, (_, i) => check({ id: `c${i}` })),
    valid: false,
  },
  { name: "duplicate check id", checks: [check(), check({ label: "別" })], valid: false },
  { name: "id with uppercase", checks: [check({ id: "Bad" }), check2()], valid: false },
  { name: "id leading hyphen", checks: [check({ id: "-lead" }), check2()], valid: false },
  { name: "id over 64 chars", checks: [check({ id: "a".repeat(65) }), check2()], valid: false },
  {
    name: "label over 80 chars",
    checks: [check({ label: "あ".repeat(81) }), check2()],
    valid: false,
  },
  { name: "non-integer points", checks: [check({ points: 12.5 }), check2()], valid: false },
  { name: "zero points", checks: [check({ points: 0 }), check2()], valid: false },
  {
    name: "penalty above points",
    checks: [check({ wrongAnswerPenalty: 51 }), check2()],
    valid: false,
  },
  {
    name: "hint id collision across checks",
    checks: [
      check({ hints: [{ id: "dup", content: "a", penalty: 0 }] }),
      check2({ hints: [{ id: "dup", content: "b", penalty: 0 }] }),
    ],
    valid: false,
  },
];

describe("multi-verify contract: SDK parser and manifest loader agree (#2252)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.valid ? "accepts" : "rejects"}: ${fx.name}`, () => {
      expect(sdkParses(fx.checks)).toBe(fx.valid);
      expect(manifestParses(fx.checks)).toBe(fx.valid);
    });
  }
});
