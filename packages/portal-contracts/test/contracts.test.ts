import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DeploymentStatus,
  type ParticipantProblemView,
  type ParticipantScoringInfo,
  type SubmitFlagOutcome,
  TERMINAL_STATUSES,
} from "../src/index.js";

describe("portal-contracts", () => {
  it("should treat exactly the five settled statuses as terminal", () => {
    const terminal: readonly DeploymentStatus[] = [
      "COMPLETE",
      "FAILED",
      "DELETED",
      "EXPIRED",
      "AUTO_DELETED",
    ];
    const inFlight: readonly DeploymentStatus[] = [
      "PENDING",
      "APPROVAL_PENDING",
      "IN_PROGRESS",
      "DELETING",
    ];
    for (const s of terminal) expect(TERMINAL_STATUSES.has(s)).toBe(true);
    for (const s of inFlight) expect(TERMINAL_STATUSES.has(s)).toBe(false);
    expect(TERMINAL_STATUSES.size).toBe(terminal.length);
  });

  it("should carry the scoring fields the SPA mirror historically dropped (#2198)", () => {
    // pointsAllOk (uptime-flat) / pointsPerAttack (attack-detection) は backend が
    // 送るのに旧 SPA ミラー型に無かった field。契約に居続けることを型で固定する。
    expectTypeOf<ParticipantScoringInfo>().toHaveProperty("pointsAllOk");
    expectTypeOf<ParticipantScoringInfo>().toHaveProperty("pointsPerAttack");
    expectTypeOf<ParticipantProblemView>().toHaveProperty("accessCapabilities");
  });

  it("should keep the submit-flag wire union limited to 200-response bodies", () => {
    // 非 200 系 (unauthorized / no_outputs 等) は HTTP status に map される backend 内部
    // outcome であり、wire contract には現れない。
    expectTypeOf<SubmitFlagOutcome["kind"]>().toEqualTypeOf<"ok" | "already_scored" | "wrong">();
  });
});
