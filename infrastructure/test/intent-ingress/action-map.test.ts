import { describe, expect, it } from "vitest";
import { mapActionToDetailType } from "../../lib/intent-ingress/action-map";

describe("mapActionToDetailType (ADR-049 Phase 4 / #2293)", () => {
  it("should map deploy to the frozen DeployCreateRequested detail-type", () => {
    expect(mapActionToDetailType("deploy")).toEqual({
      ok: true,
      detailType: "DeployCreateRequested",
    });
  });

  it("should map destroy to the frozen DeployDeleteRequested detail-type", () => {
    expect(mapActionToDetailType("destroy")).toEqual({
      ok: true,
      detailType: "DeployDeleteRequested",
    });
  });

  it("should reject inspect as not-a-deploy-command", () => {
    expect(mapActionToDetailType("inspect")).toEqual({ ok: false, reason: "not-a-deploy-command" });
  });

  it("should reject collectOutputs as not-a-deploy-command", () => {
    expect(mapActionToDetailType("collectOutputs")).toEqual({
      ok: false,
      reason: "not-a-deploy-command",
    });
  });

  it("should reject verifyTrust as not-a-deploy-command", () => {
    expect(mapActionToDetailType("verifyTrust")).toEqual({
      ok: false,
      reason: "not-a-deploy-command",
    });
  });
});
