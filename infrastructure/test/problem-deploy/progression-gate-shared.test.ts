import { describe, expect, it } from "vitest";
import {
  computeLockedProblemIds,
  isGateCompleted,
  MAX_COMPLETION_BONUS,
  ProgressionGateConfigSchema,
  parseProgressionGate,
  resolveTeamGatePolicy,
} from "../../lib/problem-deploy/handlers/shared/progression-gate";

/**
 * Issue #2283: Progression Gate の共有 schema + pure helper。
 * event-handler (設定 API) / participant-handler (enforcement) /
 * generic-scoring-handler (完了 bonus) が同じ定義を使う。
 */

const baseConfig = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle", "security-battle-royale"],
  defaultPolicy: "required" as const,
};

describe("ProgressionGateConfigSchema", () => {
  it("should accept a minimal config (gate + targets + default policy)", () => {
    const parsed = ProgressionGateConfigSchema.safeParse(baseConfig);
    expect(parsed.success).toBe(true);
  });

  it("should accept team overrides with policy and completionBonus", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      teamOverrides: {
        "team-a": { policy: "required", completionBonus: 300 },
        "team-b": { policy: "off" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("should reject a self-referencing gate (gateProblemId in unlockTargetIds)", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      unlockTargetIds: ["hello-world-battle", "stackstack-battle"],
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject duplicated unlock targets", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      unlockTargetIds: ["stackstack-battle", "stackstack-battle"],
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject an empty unlockTargetIds array", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      unlockTargetIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject an invalid problem id shape", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      gateProblemId: "Not_A_Slug!",
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject a negative or over-cap completionBonus", () => {
    for (const completionBonus of [-1, MAX_COMPLETION_BONUS + 1, 1.5]) {
      const parsed = ProgressionGateConfigSchema.safeParse({
        ...baseConfig,
        teamOverrides: { "team-a": { policy: "required", completionBonus } },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("should reject unknown keys (strict shape)", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      surprise: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject an invalid policy value", () => {
    const parsed = ProgressionGateConfigSchema.safeParse({
      ...baseConfig,
      defaultPolicy: "maybe",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("parseProgressionGate", () => {
  it("should return the config for a valid stored value", () => {
    expect(parseProgressionGate(baseConfig)).toEqual(baseConfig);
  });

  it("should return undefined for undefined / garbage stored values (lenient row parse)", () => {
    expect(parseProgressionGate(undefined)).toBeUndefined();
    expect(parseProgressionGate("nope")).toBeUndefined();
    expect(parseProgressionGate({ gateProblemId: "x" })).toBeUndefined();
  });
});

describe("resolveTeamGatePolicy", () => {
  const config = {
    ...baseConfig,
    teamOverrides: {
      beginner: { policy: "required" as const, completionBonus: 300 },
      advanced: { policy: "off" as const },
    },
  };

  it("should fall back to the event default policy with bonus 0 when the team has no override", () => {
    expect(resolveTeamGatePolicy(config, "someone-else")).toEqual({
      policy: "required",
      completionBonus: 0,
    });
  });

  it("should apply the team override policy and bonus", () => {
    expect(resolveTeamGatePolicy(config, "beginner")).toEqual({
      policy: "required",
      completionBonus: 300,
    });
    expect(resolveTeamGatePolicy(config, "advanced")).toEqual({
      policy: "off",
      completionBonus: 0,
    });
  });

  it("should fall back to the default policy when teamId is undefined", () => {
    expect(resolveTeamGatePolicy(config, undefined).policy).toBe("required");
  });
});

describe("isGateCompleted", () => {
  it("should treat a missing gate deployment row as not completed", () => {
    expect(isGateCompleted(undefined)).toBe(false);
  });

  it("should treat score > 0 as completed (first valid probe / points)", () => {
    expect(isGateCompleted({ score: 100 })).toBe(true);
    expect(isGateCompleted({ score: 0 })).toBe(false);
    expect(isGateCompleted({})).toBe(false);
  });

  it("should treat a submitted flag as completed even at score 0", () => {
    expect(isGateCompleted({ score: 0, flagSubmitted: true })).toBe(true);
  });

  it("should not treat a negative score (hint penalties) as completed", () => {
    expect(isGateCompleted({ score: -30 })).toBe(false);
  });

  it("should stay completed via the gateCompletedAt latch even if the score falls back to 0", () => {
    expect(isGateCompleted({ score: -100, gateCompletedAt: "2026-07-02T00:00:00.000Z" })).toBe(
      true,
    );
  });
});

describe("computeLockedProblemIds", () => {
  const config = {
    ...baseConfig,
    teamOverrides: { advanced: { policy: "off" as const } },
  };

  it("should lock all unlock targets for a required team before gate completion", () => {
    const locked = computeLockedProblemIds(config, "beginner", false);
    expect([...locked].sort()).toEqual(["security-battle-royale", "stackstack-battle"]);
  });

  it("should lock nothing once the gate is completed", () => {
    expect(computeLockedProblemIds(config, "beginner", true).size).toBe(0);
  });

  it("should lock nothing for a team whose policy override is off", () => {
    expect(computeLockedProblemIds(config, "advanced", false).size).toBe(0);
  });
});
