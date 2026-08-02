import { describe, expect, it } from "vitest";
import type { ParticipantProblemView, ParticipantTeamView } from "../api/portal-client";
import { viewIsUnchanged } from "./team-view-diff";

function problem(overrides: Partial<ParticipantProblemView> = {}): ParticipantProblemView {
  return {
    problemId: "ac26-w1-underconstraint",
    title: "Underconstraint",
    status: "READY",
    score: 0,
    ...overrides,
  } as ParticipantProblemView;
}

function view(problems: readonly ParticipantProblemView[]): ParticipantTeamView {
  return { team: { teamName: "alpha" }, problems } as unknown as ParticipantTeamView;
}

describe("viewIsUnchanged", () => {
  it("treats an identical view as unchanged", () => {
    const lifecycle = { status: "stopped" } as const;
    expect(viewIsUnchanged(view([problem({ lifecycle })]), view([problem({ lifecycle })]))).toBe(
      true,
    );
  });

  // Issue #2845: the refetch fired right after Start changes nothing else, so
  // missing any of these made the whole transition invisible to React.
  it.each([
    ["status", { status: "starting" } as const],
    ["lastError", { status: "error", lastError: "compose build failed" } as const],
    ["cleanupRequired", { status: "error", cleanupRequired: true } as const],
    ["runtimeKind", { status: "stopped", runtimeKind: "simulated-cloud" } as const],
  ])("detects a change confined to lifecycle.%s", (_field, next) => {
    const prev = view([problem({ lifecycle: { status: "stopped" } })]);
    expect(viewIsUnchanged(prev, view([problem({ lifecycle: next })]))).toBe(false);
  });

  it("detects lifecycle appearing or disappearing entirely", () => {
    const without = view([problem()]);
    const with_ = view([problem({ lifecycle: { status: "stopped" } })]);
    expect(viewIsUnchanged(without, with_)).toBe(false);
    expect(viewIsUnchanged(with_, without)).toBe(false);
  });
});
