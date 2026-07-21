import { describe, expect, it } from "vitest";
import {
  LOCAL_DRILL_LAUNCH_COMMAND,
  LOCAL_DRILL_PROBLEM_ID,
  matchesCheckpointCode,
  matchesLocalDrillLaunchCommand,
} from "../src/index.js";

describe("local-drill checkpoint (#2707)", () => {
  it("should expose the drill problem id and the launch-command checkpoint code", () => {
    expect(LOCAL_DRILL_PROBLEM_ID).toBe("play-local-mode");
    expect(LOCAL_DRILL_LAUNCH_COMMAND.flagId).toBe("first-score");
    expect(LOCAL_DRILL_LAUNCH_COMMAND.code).toBe("make local");
  });

  it("should match the launch-command code ignoring whitespace and letter case", () => {
    expect(matchesLocalDrillLaunchCommand("  Make Local ")).toBe(true);
    expect(matchesLocalDrillLaunchCommand(LOCAL_DRILL_LAUNCH_COMMAND.code)).toBe(true);
    expect(matchesLocalDrillLaunchCommand("make lite")).toBe(false);
  });

  it("should share one checkpoint matcher with the lite drill", () => {
    expect(matchesCheckpointCode("TENKA{X}", " tenka{x} ")).toBe(true);
    expect(matchesCheckpointCode("TENKA{X}", "tenka{y}")).toBe(false);
  });
});
