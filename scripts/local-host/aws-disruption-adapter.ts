import {
  type Command,
  GetCommandInvocationCommand,
  ListCommandsCommand,
  SendCommandCommand,
  SSMClient,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import type { DisruptionDispatch } from "@tenkacloud/problem-sdk/internal";
import { z } from "zod";
import { compareCodePoints } from "../lib/code-point-order";
import type {
  DisruptionAdapter,
  DisruptionTarget,
  Observation,
  Submission,
} from "./disruption-model";

const credentialsSchema = z.object({
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1),
});
type Ssm = Pick<SSMClient, "send" | "destroy">;
export interface AwsDisruptionClients {
  readonly sts: Pick<STSClient, "send">;
  readonly ssm?: (config: SSMClientConfig) => Ssm;
}

function parameters(dispatch: DisruptionDispatch): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(dispatch.params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : [String(value)],
    ]),
  );
}
function instances(target: DisruptionTarget): string[] {
  return target.inject.target
    .split(",")
    .map((each) => each.trim())
    .sort(compareCodePoints);
}
function equalParameters(
  left: Record<string, string[]> | undefined,
  right: Record<string, string[]>,
): boolean {
  const entries = (value: Record<string, string[]>) =>
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left ?? {})) === JSON.stringify(entries(right));
}

function matchesCommand(
  command: Command,
  args: Parameters<DisruptionAdapter["discover"]>[0],
): command is Command & { CommandId: string } {
  return Boolean(
    command.CommandId &&
      command.Comment === args.operationKey &&
      command.DocumentName === (args.dispatch.documentName ?? "AWS-RunShellScript") &&
      JSON.stringify([...(command.InstanceIds ?? [])].sort(compareCodePoints)) ===
        JSON.stringify(instances(args.target)) &&
      equalParameters(command.Parameters, parameters(args.dispatch)) &&
      command.RequestedDateTime &&
      command.RequestedDateTime.getTime() >= args.sentAt - 1000,
  );
}

/** A submitted SSM command is tracked to terminal state; transport errors are not proof of non-execution. */
export class AwsDisruptionAdapter implements DisruptionAdapter {
  constructor(
    private readonly clients: AwsDisruptionClients,
    private readonly externalId: string,
  ) {}
  private async client(target: DisruptionTarget): Promise<Ssm> {
    const assumed = await this.clients.sts.send(
      new AssumeRoleCommand({
        RoleArn: target.roleArn,
        RoleSessionName: `tc-disruption-${target.jobId}`,
        ExternalId: this.externalId,
        DurationSeconds: 900,
      }),
      { abortSignal: AbortSignal.timeout(4000) },
    );
    const parsed = credentialsSchema.parse(assumed.Credentials);
    const credentials = {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      sessionToken: parsed.SessionToken,
    };
    const config = { region: target.region, credentials, maxAttempts: 1 };
    return this.clients.ssm?.(config) ?? new SSMClient(config);
  }
  async submit(args: Parameters<DisruptionAdapter["submit"]>[0]): Promise<Submission> {
    let client: Ssm | undefined;
    try {
      client = await this.client(args.target);
      args.assertCurrent();
    } catch {
      client?.destroy();
      return {
        kind: "rejected",
        reason: "The role or current environment does not permit this operation.",
      };
    }
    try {
      const result = await client.send(
        new SendCommandCommand({
          DocumentName: args.dispatch.documentName ?? "AWS-RunShellScript",
          InstanceIds: instances(args.target),
          Parameters: parameters(args.dispatch),
          Comment: args.operationKey,
          TimeoutSeconds: 30,
        }),
        { abortSignal: AbortSignal.timeout(4000) },
      );
      return result.Command?.CommandId
        ? { kind: "accepted", operationId: result.Command.CommandId }
        : { kind: "unknown", reason: "SSM returned no command ID. The command may still execute." };
    } catch {
      return {
        kind: "unknown",
        reason: "SSM submission outcome is unknown. The command may still execute.",
      };
    } finally {
      client.destroy();
    }
  }
  async observe(args: Parameters<DisruptionAdapter["observe"]>[0]): Promise<Observation> {
    let client: Ssm | undefined;
    try {
      client = await this.client(args.target);
      const statuses: string[] = [];
      for (const instanceId of instances(args.target)) {
        const response = await client.send(
          new GetCommandInvocationCommand({ CommandId: args.operationId, InstanceId: instanceId }),
          { abortSignal: AbortSignal.timeout(4000) },
        );
        statuses.push(response.Status ?? "Unknown");
      }
      if (statuses.every((status) => status === "Success")) return { kind: "completed" };
      const terminal = new Set(["Success", "Failed", "Cancelled", "TimedOut"]);
      if (statuses.every((status) => terminal.has(status)))
        return {
          kind: "failed",
          reason:
            "SSM reported a failed, cancelled or timed-out command. Its recovery command is still required.",
        };
      return { kind: "pending" };
    } catch {
      return {
        kind: "unknown",
        reason:
          "SSM command completion is not known. Missing invocations can be eventually consistent.",
      };
    } finally {
      client?.destroy();
    }
  }
  async discover(
    args: Parameters<DisruptionAdapter["discover"]>[0],
  ): ReturnType<DisruptionAdapter["discover"]> {
    let client: Ssm | undefined;
    try {
      client = await this.client(args.target);
      const found = new Set<string>();
      let nextToken: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await client.send(
          new ListCommandsCommand({
            Filters: [{ key: "InvokedAfter", value: new Date(args.sentAt - 60_000).toISOString() }],
            MaxResults: 50,
            NextToken: nextToken,
          }),
          { abortSignal: AbortSignal.timeout(4000) },
        );
        const matches = (response.Commands ?? []).filter((command) =>
          matchesCommand(command, args),
        );
        for (const command of matches) found.add(command.CommandId);
        nextToken = response.NextToken;
        if (!nextToken) break;
      }
      const operationId = !nextToken && found.size === 1 ? [...found][0] : undefined;
      if (operationId) return { kind: "found", operationId };
      return {
        kind: "unknown",
        reason:
          found.size > 1
            ? "Multiple matching SSM commands require operator recovery."
            : "The original SSM command has not been identified. No retry or completed recovery can be claimed.",
      };
    } catch {
      return {
        kind: "unknown",
        reason: "SSM command discovery failed; recovery remains required.",
      };
    } finally {
      client?.destroy();
    }
  }
}
