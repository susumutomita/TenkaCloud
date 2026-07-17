import { describe, expect, it } from "vitest";
import {
  findLiteDrillCheckpointCode,
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  matchesLiteDrillCheckpoint,
} from "../src/index.js";

describe("lite-drill checkpoints (#2696)", () => {
  it("should expose the drill problem id used by the demo portal fixture", () => {
    expect(LITE_DRILL_PROBLEM_ID).toBe("deploy-tenkacloud-lite");
  });

  it("should declare four checkpoints with unique flag ids and unique codes", () => {
    const entries = Object.values(LITE_DRILL_CHECKPOINTS);
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((c) => c.flagId)).size).toBe(entries.length);
    expect(new Set(entries.map((c) => c.code)).size).toBe(entries.length);
  });

  it("should keep every code in the TENKA{...} shape so learners recognize it on sight", () => {
    for (const { code } of Object.values(LITE_DRILL_CHECKPOINTS)) {
      expect(code).toMatch(/^TENKA\{[A-Z0-9-]+\}$/);
    }
  });

  it("should resolve a checkpoint code by flag id and return undefined for unknown ids", () => {
    expect(findLiteDrillCheckpointCode("deploy-complete")).toBe(
      LITE_DRILL_CHECKPOINTS.deployComplete.code,
    );
    expect(findLiteDrillCheckpointCode("no-such-flag")).toBeUndefined();
  });

  it("should match a submitted code ignoring surrounding whitespace and letter case", () => {
    expect(matchesLiteDrillCheckpoint("launcher-created", "  tenka{lite-launcher-ready} ")).toBe(
      true,
    );
    expect(
      matchesLiteDrillCheckpoint("launcher-created", LITE_DRILL_CHECKPOINTS.launcherCreated.code),
    ).toBe(true);
  });

  it("should reject a wrong code, a cross-checkpoint code, and an unknown flag id", () => {
    expect(matchesLiteDrillCheckpoint("launcher-created", "TENKA{WRONG}")).toBe(false);
    expect(
      matchesLiteDrillCheckpoint("launcher-created", LITE_DRILL_CHECKPOINTS.deployComplete.code),
    ).toBe(false);
    expect(
      matchesLiteDrillCheckpoint("no-such-flag", LITE_DRILL_CHECKPOINTS.launcherCreated.code),
    ).toBe(false);
  });
});
