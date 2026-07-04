import {
  type CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
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
            Outputs: [{ OutputKey: "ArchiveFunctionName", OutputValue: "archive-runtime-a" }],
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
        archiveFunctionName: "archive-runtime-a",
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

  it("should invoke the archive Lambda synchronously and surface function errors", async () => {
    const cfnSend = vi.fn(async () => ({}));
    const lambdaSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        FunctionError: "Unhandled",
        Payload: new TextEncoder().encode('{"errorMessage":"archive failed"}'),
      });
    const client = createCfnStacksClient(
      { send: cfnSend } as unknown as CloudFormationClient,
      { send: lambdaSend } as unknown as LambdaClient,
    );

    await client.archiveStack("archive-fn", "evt-1");
    const command = lambdaSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(InvokeCommand);
    expect((command as InvokeCommand).input).toMatchObject({
      FunctionName: "archive-fn",
      InvocationType: "RequestResponse",
    });
    expect(new TextDecoder().decode((command as InvokeCommand).input.Payload)).toBe(
      '{"eventId":"evt-1"}',
    );

    await expect(client.archiveStack("archive-fn", "evt-1")).rejects.toThrow(
      /archive Lambda failed.*archive failed/,
    );
  });

  it("should fail loudly when archive support is used without a Lambda client", async () => {
    const client = createCfnStacksClient({
      send: vi.fn(async () => ({})),
    } as unknown as CloudFormationClient);
    await expect(client.archiveStack("archive-fn", "evt-1")).rejects.toThrow(
      /Lambda client is required/,
    );
  });
});
