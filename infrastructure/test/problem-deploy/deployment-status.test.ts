import { describe, expect, it } from "vitest";
import { DeploymentStatusSchema } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import { DELETED_LIKE_STATUSES } from "../../lib/problem-deploy/handlers/shared/constants";

describe("DeploymentStatusSchema", () => {
  it("auto-delete lifecycle status を許可すべき", () => {
    expect(DeploymentStatusSchema.parse("EXPIRED")).toBe("EXPIRED");
    expect(DeploymentStatusSchema.parse("AUTO_DELETED")).toBe("AUTO_DELETED");
  });

  it("EXPIRED / AUTO_DELETED は削除済み扱いにすべき", () => {
    expect(DELETED_LIKE_STATUSES.has("EXPIRED")).toBe(true);
    expect(DELETED_LIKE_STATUSES.has("AUTO_DELETED")).toBe(true);
  });
});
