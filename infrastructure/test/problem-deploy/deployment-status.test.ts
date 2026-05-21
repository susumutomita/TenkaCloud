import { describe, expect, it } from "vitest";
import { DeploymentStatusSchema } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import { DELETED_LIKE_STATUSES } from "../../lib/problem-deploy/handlers/shared/constants";

describe("DeploymentStatusSchema", () => {
  it("should allow auto-delete lifecycle status", () => {
    expect(DeploymentStatusSchema.parse("EXPIRED")).toBe("EXPIRED");
    expect(DeploymentStatusSchema.parse("AUTO_DELETED")).toBe("AUTO_DELETED");
  });

  it("should treat EXPIRED / AUTO_DELETED as deleted", () => {
    expect(DELETED_LIKE_STATUSES.has("EXPIRED")).toBe(true);
    expect(DELETED_LIKE_STATUSES.has("AUTO_DELETED")).toBe(true);
  });
});
