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

  it("should collapse internal double-spaces in a multi-word code (2026-07-21)", () => {
    expect(matchesLocalDrillLaunchCommand("make  local")).toBe(true);
    expect(matchesLocalDrillLaunchCommand("make   local")).toBe(true);
  });

  it("should accept every real launch command that also starts the portal (2026-07-21)", () => {
    expect(matchesLocalDrillLaunchCommand("tenkacloud local")).toBe(true);
    expect(matchesLocalDrillLaunchCommand("bun run tenkacloud local")).toBe(true);
    expect(matchesLocalDrillLaunchCommand("BUN RUN TENKACLOUD LOCAL")).toBe(true);
  });

  it("should reject make local-up (API-only, does not start the portal)", () => {
    expect(matchesLocalDrillLaunchCommand("make local-up")).toBe(false);
  });

  it("should share one checkpoint matcher with the lite drill", () => {
    expect(matchesCheckpointCode("TC{X}", " tc{x} ")).toBe(true);
    expect(matchesCheckpointCode("TC{X}", "tc{y}")).toBe(false);
  });
});
