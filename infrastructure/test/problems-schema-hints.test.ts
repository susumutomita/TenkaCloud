import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

/**
 * Issue #742 Phase 5: `hints` を全 5 builtin scoring kind で受け入れることを
 * SCHEMA.json レイヤーでも pin する (= Phase 5 までは scoring-metadata.ts parser
 * 側のみ拡張されていて、 metadata.json 直書きの hints は SCHEMA で剥奪されていた)。
 *
 * 本テストは Ajv で SCHEMA.json をそのまま validate する (= validate-problems.ts
 * と同じ検証経路)。 hints の v1 (string[]) / v2 (object[]) 混在パターンと、
 * id 欠落 / penalty 負値 / 不明 property 等の reject も pin する。
 */

const SCHEMA_PATH = join(__dirname, "../../problems/SCHEMA.json");

function createValidator(): ReturnType<Ajv2020["compile"]> {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function baseProblem(scoring: unknown): Record<string, unknown> {
  return {
    id: "test-problem",
    name: "テスト問題",
    category: "Challenge",
    status: "draft",
    difficulty: 1,
    estimatedDuration: "10 分",
    shortDescription: "test",
    description: "test",
    tags: ["test"],
    exposedPorts: [{ port: 80, name: "main" }],
    learningGoals: ["test"],
    cfnTemplate: "template.yaml",
    scoring,
  };
}

describe("[#742 Phase 5] SCHEMA.json: hints should be valid across all 5 kinds", () => {
  const validate = createValidator();
  const validV2Hint = { id: "hint-1", content: "first hint", penalty: 10 } as const;
  const validV1Hint = "legacy string hint";

  it("should accept hints (v2) for kind=flag", () => {
    const ok = validate(
      baseProblem({
        kind: "flag",
        flagOutputKey: "Flag",
        points: 100,
        hints: [validV2Hint, validV1Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("should accept hints for kind=uptime (legacy)", () => {
    const ok = validate(
      baseProblem({
        kind: "uptime",
        endpoints: [{ outputKey: "BaseUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 10,
        hints: [validV1Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("should accept hints for kind=uptime-flat", () => {
    const ok = validate(
      baseProblem({
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 10,
        hints: [validV2Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("should accept hints for kind=uptime-multi", () => {
    const ok = validate(
      baseProblem({
        kind: "uptime-multi",
        probedSlots: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsAllOk: 100,
        hints: [validV2Hint, validV1Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("should accept hints for kind=phased-polling", () => {
    const ok = validate(
      baseProblem({
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100 } },
        hints: [validV2Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("should accept hints for kind=attack-detection", () => {
    const ok = validate(
      baseProblem({
        kind: "attack-detection",
        statsOutputKey: "AttackCount",
        pointsPerAttack: 10,
        hints: [validV2Hint],
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe("[#742 Phase 5] SCHEMA.json: should reject invalid hints shape", () => {
  const validate = createValidator();

  it("should reject when a hints element is missing `id` (required in v2 object)", () => {
    const ok = validate(
      baseProblem({
        kind: "flag",
        flagOutputKey: "Flag",
        points: 100,
        hints: [{ content: "missing id", penalty: 0 }],
      }),
    );
    expect(ok).toBe(false);
  });

  it("should reject when hints[].penalty is negative (minimum 0)", () => {
    const ok = validate(
      baseProblem({
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 10,
        hints: [{ id: "h1", content: "negative penalty", penalty: -5 }],
      }),
    );
    expect(ok).toBe(false);
  });

  it("should reject hints[] objects with unknown properties (additionalProperties false)", () => {
    const ok = validate(
      baseProblem({
        kind: "attack-detection",
        statsOutputKey: "AttackCount",
        pointsPerAttack: 10,
        hints: [{ id: "h1", content: "extra", penalty: 0, extra: "nope" }],
      }),
    );
    expect(ok).toBe(false);
  });

  it("should reject when hints is not an array", () => {
    const ok = validate(
      baseProblem({
        kind: "flag",
        flagOutputKey: "Flag",
        points: 100,
        hints: "not-an-array",
      }),
    );
    expect(ok).toBe(false);
  });
});
