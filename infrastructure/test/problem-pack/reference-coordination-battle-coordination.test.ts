/**
 * [#2195] The reference coordination plugin must be a real, exercised consumer of
 * the coordination SDK.
 *
 * This drives the pack's default-exported `CoordinationPlugin` through the SDK
 * host utilities (`dispatchOp` / `runTick` / `safeProjectForTeam`) exactly as the
 * dispatcher Lambda would, covering every validate/apply/tick/project branch. It
 * is the worked example that keeps the coordination SDK exports from being
 * consumer-zero (the #2195 adopt decision).
 */

import { dispatchOp, runTick, safeProjectForTeam } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "../../../packs/reference-coordination-battle/problems/battles/cross-account-capture/coordination/sector-control";

const CTX = { eventId: "evt-1", teamIds: ["team-a", "team-b"] };
const fresh = () => plugin.initialState(CTX);

describe("reference coordination plugin: cross-account sector control (#2195)", () => {
  it("should open with every sector free and the capture window open", () => {
    const state = fresh();
    expect(state.phase).toBe("open");
    expect(Object.keys(state.holders)).toHaveLength(4);
    expect(Object.values(state.holders).every((holder) => holder === null)).toBe(true);
  });

  it("should let a team claim a free sector", () => {
    const result = dispatchOp(plugin, fresh(), "team-a", { type: "claim", sector: "us-east-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.holders["us-east-1"]).toBe("team-a");
      expect(result.state.holders["eu-west-1"]).toBeNull();
    }
  });

  it("should reject claiming a sector held by another team", () => {
    const held = plugin.applyOp(fresh(), "team-b", { type: "claim", sector: "us-east-1" });
    const result = dispatchOp(plugin, held, "team-a", { type: "claim", sector: "us-east-1" });
    expect(result).toEqual({ ok: false, error: "sector_taken" });
  });

  it("should reject re-claiming a sector the team already holds", () => {
    const held = plugin.applyOp(fresh(), "team-a", { type: "claim", sector: "eu-west-1" });
    const result = dispatchOp(plugin, held, "team-a", { type: "claim", sector: "eu-west-1" });
    expect(result).toEqual({ ok: false, error: "already_yours" });
  });

  it("should reject an unknown sector", () => {
    const claim = dispatchOp(plugin, fresh(), "team-a", { type: "claim", sector: "mars-1" });
    expect(claim).toEqual({ ok: false, error: "unknown_sector" });
    const release = dispatchOp(plugin, fresh(), "team-a", { type: "release", sector: "mars-1" });
    expect(release).toEqual({ ok: false, error: "unknown_sector" });
  });

  it("should reject any claim once the capture window is locked", () => {
    const locked = { holders: fresh().holders, phase: "locked" as const };
    const result = dispatchOp(plugin, locked, "team-a", { type: "claim", sector: "us-east-1" });
    expect(result).toEqual({ ok: false, error: "event_locked" });
  });

  it("should let a team release a sector it holds", () => {
    const held = plugin.applyOp(fresh(), "team-a", { type: "claim", sector: "sa-east-1" });
    const result = dispatchOp(plugin, held, "team-a", { type: "release", sector: "sa-east-1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.holders["sa-east-1"]).toBeNull();
  });

  it("should reject releasing a sector the team does not hold", () => {
    const held = plugin.applyOp(fresh(), "team-b", { type: "claim", sector: "sa-east-1" });
    const result = dispatchOp(plugin, held, "team-a", { type: "release", sector: "sa-east-1" });
    expect(result).toEqual({ ok: false, error: "not_your_sector" });
  });

  it("should close the capture window on tick after the window elapses", () => {
    const opened = fresh();
    const ticked = runTick(plugin, opened, 15 * 60 * 1000);
    expect(ticked.phase).toBe("locked");
  });

  it("should leave state unchanged on tick before the window elapses", () => {
    const opened = fresh();
    expect(runTick(plugin, opened, 15 * 60 * 1000 - 1)).toBe(opened);
  });

  it("should leave state unchanged on tick once already locked", () => {
    const locked = { holders: fresh().holders, phase: "locked" as const };
    expect(runTick(plugin, locked, 60 * 60 * 1000)).toBe(locked);
  });

  it("should project only a team's own holdings plus anonymous counts", () => {
    let state = plugin.applyOp(fresh(), "team-a", { type: "claim", sector: "us-east-1" });
    state = plugin.applyOp(state, "team-b", { type: "claim", sector: "eu-west-1" });

    const projection = safeProjectForTeam(plugin, state, "team-a", {
      phase: "open",
      heldByMe: [],
      free: 0,
      takenByOthers: 0,
    });

    expect(projection).toEqual({
      phase: "open",
      heldByMe: ["us-east-1"],
      free: 2,
      takenByOthers: 1,
    });
  });
});
