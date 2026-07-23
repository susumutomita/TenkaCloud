import { describe, expect, it } from "vitest";
import {
  findLiteDrillCheckpointCode,
  LITE_CLEANUP_DRILL_CHECKPOINT,
  LITE_CLEANUP_DRILL_PROBLEM_ID,
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  matchesLiteCleanupDrillCheckpoint,
  matchesLiteDrillCheckpoint,
} from "../src/index.js";

describe("lite-drill checkpoints (#2696)", () => {
  it("should expose the drill problem id used by the demo portal fixture", () => {
    expect(LITE_DRILL_PROBLEM_ID).toBe("deploy-tenkacloud-lite");
    expect(LITE_CLEANUP_DRILL_PROBLEM_ID).toBe("cleanup-tenkacloud-lite");
  });

  it("should declare four checkpoints with unique flag ids and unique codes", () => {
    const entries = Object.values(LITE_DRILL_CHECKPOINTS);
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((c) => c.flagId)).size).toBe(entries.length);
    expect(new Set(entries.map((c) => c.code)).size).toBe(entries.length);
  });

  it("should keep every code in the TC{...} shape so learners recognize it on sight", () => {
    for (const { code } of Object.values(LITE_DRILL_CHECKPOINTS)) {
      expect(code).toMatch(/^TC\{[A-Z0-9-]+\}$/);
    }
  });

  it("should resolve a checkpoint code by flag id and return undefined for unknown ids", () => {
    expect(findLiteDrillCheckpointCode("deploy-complete")).toBe(
      LITE_DRILL_CHECKPOINTS.deployComplete.code,
    );
    expect(findLiteDrillCheckpointCode("no-such-flag")).toBeUndefined();
  });

  it("should match a submitted code ignoring surrounding whitespace and letter case", () => {
    expect(matchesLiteDrillCheckpoint("launcher-created", "  tc{lite-launcher-ready} ")).toBe(true);
    expect(
      matchesLiteDrillCheckpoint("launcher-created", LITE_DRILL_CHECKPOINTS.launcherCreated.code),
    ).toBe(true);
  });

  it("should reject a wrong code, a cross-checkpoint code, and an unknown flag id", () => {
    expect(matchesLiteDrillCheckpoint("launcher-created", "TC{WRONG}")).toBe(false);
    expect(
      matchesLiteDrillCheckpoint("launcher-created", LITE_DRILL_CHECKPOINTS.deployComplete.code),
    ).toBe(false);
    expect(
      matchesLiteDrillCheckpoint("no-such-flag", LITE_DRILL_CHECKPOINTS.launcherCreated.code),
    ).toBe(false);
  });

  it("should keep cleanup as a separate one-checkpoint drill", () => {
    expect(LITE_CLEANUP_DRILL_CHECKPOINT.flagId).toBe("cleanup-complete");
    expect(LITE_CLEANUP_DRILL_CHECKPOINT.code).toMatch(/^TC\{[A-Z0-9-]+\}$/);
    expect(
      matchesLiteCleanupDrillCheckpoint(
        LITE_CLEANUP_DRILL_CHECKPOINT.flagId,
        ` ${LITE_CLEANUP_DRILL_CHECKPOINT.code.toLowerCase()} `,
      ),
    ).toBe(true);
    expect(
      matchesLiteCleanupDrillCheckpoint(
        LITE_CLEANUP_DRILL_CHECKPOINT.flagId,
        LITE_DRILL_CHECKPOINTS.deployComplete.code,
      ),
    ).toBe(false);
  });
});
