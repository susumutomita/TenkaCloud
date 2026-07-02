import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PORTAL_SLOT_NAMES,
  type PortalCoordinationClient,
  type PortalCoordinationOutcome,
  type PortalSlotComponent,
  type PortalSlotName,
  type PortalSlotProps,
} from "../src/index.js";

/**
 * Issue #2206: portal-plugin-sdk had zero tests despite being consumed by
 * participant-portal's plugin loader. This pins the runtime surface
 * (`PORTAL_SLOT_NAMES`, the only value export) and the public type shapes a
 * problem author's `portal/<SlotName>.tsx` must satisfy.
 */
describe("PORTAL_SLOT_NAMES", () => {
  it("should declare exactly the 3 reserved slot names participant-portal renders", () => {
    expect(PORTAL_SLOT_NAMES).toEqual(["StatusPanel", "RegistrationPanel", "HelpDrawer"]);
  });

  it("should type each element as a PortalSlotName literal", () => {
    const slots: readonly PortalSlotName[] = PORTAL_SLOT_NAMES;
    expect(slots).toHaveLength(3);
  });
});

describe("PortalSlotProps / PortalSlotComponent (type-level)", () => {
  it("should accept a component whose props type is exactly PortalSlotProps", () => {
    const StatusPanel: PortalSlotComponent = (_props: PortalSlotProps) => null;
    expectTypeOf(StatusPanel).parameter(0).toEqualTypeOf<PortalSlotProps>();
  });

  it("should require team/problemId/jobId/score/locale/endpoints/phases/disruptions/nowIso", () => {
    const props: PortalSlotProps = {
      team: { teamName: "Alpha" },
      problemId: "sqli-demo",
      jobId: "job-1",
      score: 0,
      locale: "ja",
      endpoints: [],
      phases: [],
      disruptions: [],
      nowIso: "2026-01-01T00:00:00.000Z",
    };
    expect(props.problemId).toBe("sqli-demo");
  });

  it("should type coordinationClient.submitOp/getProjection as returning a PortalCoordinationOutcome", () => {
    const client: PortalCoordinationClient = {
      submitOp: async () => ({ kind: "ok", projection: {} }),
      getProjection: async () => ({ kind: "not_configured" }),
    };
    expectTypeOf(client.submitOp).returns.resolves.toEqualTypeOf<PortalCoordinationOutcome>();
  });
});
