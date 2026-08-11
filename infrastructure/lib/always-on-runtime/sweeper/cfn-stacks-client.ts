import {
  type CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { TAG_EVENT_ID, TAG_EXPIRES_AT, TAG_MANAGED_BY, TAG_TENANT_ID } from "../runtime-tags.js";
import type { CfnStacksClient, ManagedStack } from "./sweep.js";

/**
 * Issue #2293 — the real CloudFormation edge for the cleanup sweeper.
 *
 * Kept deliberately thin: it lists stacks (paginated `DescribeStacks`, which is the only list call
 * that returns tags), projects each one down to its `TenkaCloud:*` tags, and forwards `DeleteStack`.
 * ALL sweep/safety logic lives in the pure core ({@link ./sweep.ts}) — this adapter never decides
 * what to delete, so the "never touch a non-always-on stack" invariant has a single home.
 */

/** Read one `TenkaCloud:*` tag value off a stack, or `undefined` when absent. */
function tagValue(stack: Stack, key: string): string | undefined {
  return stack.Tags?.find((tag) => tag.Key === key)?.Value;
}

function outputValue(stack: Stack, key: string): string | undefined {
  return stack.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;
}

/** Project a CloudFormation `Stack` down to the tag subset the sweeper core reasons about. */
function toManagedStack(stack: Stack): ManagedStack {
  const managedBy = tagValue(stack, TAG_MANAGED_BY);
  const expiresAt = tagValue(stack, TAG_EXPIRES_AT);
  const tenantId = tagValue(stack, TAG_TENANT_ID);
  const eventId = tagValue(stack, TAG_EVENT_ID);
  const archiveFunctionName = outputValue(stack, "ArchiveFunctionName");
  return {
    stackName: stack.StackName ?? "",
    ...(managedBy !== undefined ? { managedBy } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(archiveFunctionName !== undefined ? { archiveFunctionName } : {}),
  };
}

/** Build a {@link CfnStacksClient} over a real (or faked) `CloudFormationClient`. */
export function createCfnStacksClient(
  client: CloudFormationClient,
  lambda?: LambdaClient,
): CfnStacksClient {
  return {
    async listManagedStacks(): Promise<readonly ManagedStack[]> {
      const managed: ManagedStack[] = [];
      let nextToken: string | undefined;
      do {
        const res = await client.send(
          new DescribeStacksCommand(nextToken ? { NextToken: nextToken } : {}),
        );
        for (const stack of res.Stacks ?? []) {
          managed.push(toManagedStack(stack));
        }
        nextToken = res.NextToken;
      } while (nextToken);
      return managed;
    },
    async deleteStack(stackName: string): Promise<void> {
      await client.send(new DeleteStackCommand({ StackName: stackName }));
    },
    async archiveStack(archiveFunctionName: string, eventId: string): Promise<void> {
      if (!lambda) throw new Error("Lambda client is required to archive an expired runtime");
      const response = await lambda.send(
        new InvokeCommand({
          FunctionName: archiveFunctionName,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify({ eventId })),
        }),
      );
      if (response.FunctionError) {
        const payload = response.Payload ? new TextDecoder().decode(response.Payload) : "";
        throw new Error(
          `archive Lambda failed: ${response.FunctionError}${payload ? `: ${payload}` : ""}`,
        );
      }
    },
  };
}
