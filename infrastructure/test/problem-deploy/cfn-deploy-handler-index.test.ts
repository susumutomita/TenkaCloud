import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #2291: the cfn-deploy Lambda `index.ts` dispatches one Lambda to create /
 * delete / describe-delete by the `action` field. The create SM sends no `action` (backward
 * compatible → create); the delete SM sends `action: "delete"` then `action: "describe-delete"`.
 * The underlying handlers are mocked (their real-SDK entries build clients + call AWS).
 */
const mocks = vi.hoisted(() => ({
  createHandler: vi.fn(async () => ({ stackId: "arn:create" })),
  deleteHandler: vi.fn(async () => ({ deleted: true })),
  describeDeleteHandler: vi.fn(async () => ({ Stacks: [{ StackStatus: "DELETE_COMPLETE" }] })),
}));

vi.mock("../../lib/problem-deploy/handlers/cfn-deploy-handler/create-stack", () => ({
  handler: mocks.createHandler,
}));
vi.mock("../../lib/problem-deploy/handlers/cfn-deploy-handler/delete-stack", () => ({
  deleteHandler: mocks.deleteHandler,
  describeDeleteHandler: mocks.describeDeleteHandler,
}));

import { handler } from "../../lib/problem-deploy/handlers/cfn-deploy-handler/index.js";

const detail = { detail: { jobId: "01HX0000000000000000000ABC" } };

describe("cfn-deploy-handler index dispatch (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should route an event with no action to the create handler (backward compatible)", async () => {
    await handler({ ...detail });
    expect(mocks.createHandler).toHaveBeenCalledOnce();
    expect(mocks.deleteHandler).not.toHaveBeenCalled();
    expect(mocks.describeDeleteHandler).not.toHaveBeenCalled();
  });

  it("should route action=create to the create handler", async () => {
    await handler({ action: "create", ...detail });
    expect(mocks.createHandler).toHaveBeenCalledOnce();
  });

  it("should route action=delete to the delete handler", async () => {
    await handler({ action: "delete", ...detail });
    expect(mocks.deleteHandler).toHaveBeenCalledOnce();
    expect(mocks.createHandler).not.toHaveBeenCalled();
  });

  it("should route action=describe-delete to the describe-delete handler", async () => {
    await handler({ action: "describe-delete", ...detail });
    expect(mocks.describeDeleteHandler).toHaveBeenCalledOnce();
    expect(mocks.createHandler).not.toHaveBeenCalled();
  });
});
