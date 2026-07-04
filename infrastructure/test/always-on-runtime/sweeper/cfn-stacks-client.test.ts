import {
  type CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_BY_ALWAYS_ON_RUNTIME,
  TAG_EVENT_ID,
  TAG_EXPIRES_AT,
  TAG_MANAGED_BY,
  TAG_TENANT_ID,
} from "../../../lib/always-on-runtime/runtime-tags";
import { createCfnStacksClient } from "../../../lib/always-on-runtime/sweeper/cfn-stacks-client";

describe("createCfnStacksClient", () => {
  it("should project TenkaCloud:* tags across paginated DescribeStacks pages", async () => {
    const pages = [
      {
        Stacks: [
          {
            StackName: "runtime-a",
            Tags: [
              { Key: TAG_MANAGED_BY, Value: MANAGED_BY_ALWAYS_ON_RUNTIME },
              { Key: TAG_EXPIRES_AT, Value: "2026-07-01T00:00:00.000Z" },
              { Key: TAG_TENANT_ID, Value: "tenant-1" },
              { Key: TAG_EVENT_ID, Value: "evt-1" },
            ],
          },
        ],
        NextToken: "page-2",
      },
      { Stacks: [{ StackName: "runtime-b" }] }, // untagged stack, no NextToken → loop ends
    ];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DescribeStacksCommand) return pages.shift();
      return {};
    });
    const client = createCfnStacksClient({ send } as unknown as CloudFormationClient);

    const stacks = await client.listManagedStacks();

    expect(send).toHaveBeenCalledTimes(2);
    expect(stacks).toEqual([
      {
        stackName: "runtime-a",
        managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME,
        expiresAt: "2026-07-01T00:00:00.000Z",
        tenantId: "tenant-1",
        eventId: "evt-1",
      },
      { stackName: "runtime-b" },
    ]);
  });

  it("should default a missing StackName to an empty string", async () => {
    // A Stack with no StackName exercises the `stack.StackName ?? ""` fallback.
    const send = vi.fn(async () => ({
      Stacks: [{ Tags: [{ Key: TAG_MANAGED_BY, Value: MANAGED_BY_ALWAYS_ON_RUNTIME }] }],
    }));
    const client = createCfnStacksClient({ send } as unknown as CloudFormationClient);

    const stacks = await client.listManagedStacks();

    expect(stacks).toEqual([{ stackName: "", managedBy: MANAGED_BY_ALWAYS_ON_RUNTIME }]);
  });

  it("should tolerate a DescribeStacks page that returns no Stacks field", async () => {
    // A response with undefined `Stacks` (and no NextToken) exercises the `res.Stacks ?? []` fallback.
    const send = vi.fn(async () => ({}));
    const client = createCfnStacksClient({ send } as unknown as CloudFormationClient);

    const stacks = await client.listManagedStacks();

    expect(stacks).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should send DeleteStack by stack name", async () => {
    const send = vi.fn(async () => ({}));
    const client = createCfnStacksClient({ send } as unknown as CloudFormationClient);

    await client.deleteStack("runtime-x");

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteStackCommand);
    expect((command as DeleteStackCommand).input).toEqual({ StackName: "runtime-x" });
  });
});
