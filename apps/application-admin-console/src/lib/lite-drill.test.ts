import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import { liteDrillCheckpointCode } from "./lite-drill";

describe("liteDrillCheckpointCode (#2696)", () => {
  it("should return the checkpoint code when the console runs in Lite mode (tenantId=local)", () => {
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "competitorVerified")).toBe(
      LITE_DRILL_CHECKPOINTS.competitorVerified.code,
    );
    expect(liteDrillCheckpointCode({ tenantId: "local" }, "firstEventCreated")).toBe(
      LITE_DRILL_CHECKPOINTS.firstEventCreated.code,
    );
  });

  it("should hide the code for SaaS tenants and the no-AWS demo mode", () => {
    expect(liteDrillCheckpointCode({ tenantId: "pooled" }, "competitorVerified")).toBeUndefined();
    expect(
      liteDrillCheckpointCode({ tenantId: "demo-tenant" }, "firstEventCreated"),
    ).toBeUndefined();
  });
});
