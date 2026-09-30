import {
  CreateStackCommand,
  type CreateStackCommandInput,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Tag,
} from "@aws-sdk/client-cloudformation";
import {
  AssumeRoleCommand,
  type AssumeRoleCommandInput,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";
import type { CredentialsProvider } from "../cloudformation-engine";

export const OPERATOR_ACCOUNT = "999999999999";

interface FakeStack {
  stackId: string;
  name: string;
  status: string;
  tags: Tag[];
  reason?: string;
}

/** The flag a fake stack reports: unique per stack, so one team's flag never fits another's. */
export function fakeFlag(stackName: string): string {
  return `TC{${stackName}}`;
}

/** STS and CloudFormation as they behave for these calls; each poll moves a stack one step. */
export class FakeAws {
  readonly assumed: AssumeRoleCommandInput[] = [];
  readonly created: CreateStackCommandInput[] = [];
  readonly deleted: string[] = [];
  readonly stacks: FakeStack[] = [];
  createOutcome: "complete" | "rollback" | "lost-response" = "complete";
  beforeCreate?: (input: CreateStackCommandInput) => void;
  /** False models a template whose stack completes without the flag output. */
  flagOutput = true;
  identityCalls = 0;

  readonly sts = {
    send: async (command: unknown) => {
      if (command instanceof GetCallerIdentityCommand) {
        this.identityCalls += 1;
        return { Account: OPERATOR_ACCOUNT };
      }
      if (!(command instanceof AssumeRoleCommand)) throw new Error("unexpected STS call");
      this.assumed.push(command.input);
      return {
        Credentials: {
          AccessKeyId: "AKIA",
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: new Date(Date.now() + 900_000),
        },
      };
    },
  };

  readonly cloudFormation = (credentials: CredentialsProvider) => ({
    send: async (command: unknown) => {
      await credentials();
      if (command instanceof CreateStackCommand) return this.create(command.input);
      if (command instanceof DescribeStacksCommand)
        return this.describe(String(command.input.StackName));
      if (command instanceof DeleteStackCommand) {
        const stack = this.find(String(command.input.StackName));
        if (stack) {
          this.deleted.push(stack.stackId);
          stack.status = "DELETE_IN_PROGRESS";
        }
        return {};
      }
      throw new Error("unexpected CloudFormation call");
    },
  });

  private create(input: CreateStackCommandInput) {
    this.created.push(input);
    this.beforeCreate?.(input);
    const name = String(input.StackName);
    if (this.find(name)) throw new Error(`Stack ${name} already exists`);
    const stack = this.seedStack(name, input.Tags ?? []);
    stack.status = "CREATE_IN_PROGRESS";
    if (this.createOutcome === "lost-response") throw new Error("socket hang up");
    return { StackId: stack.stackId };
  }

  seedStack(name: string, tags: Tag[] = []): FakeStack {
    const stack: FakeStack = {
      stackId: `arn:aws:cloudformation:ap-northeast-1:111:stack/${name}/${this.stacks.length}`,
      name,
      status: "CREATE_COMPLETE",
      tags,
    };
    this.stacks.push(stack);
    return stack;
  }

  private find(nameOrId: string): FakeStack | undefined {
    return this.stacks.find(
      (stack) =>
        stack.stackId === nameOrId ||
        (stack.name === nameOrId && stack.status !== "DELETE_COMPLETE"),
    );
  }

  private describe(nameOrId: string) {
    const stack = this.find(nameOrId);
    if (!stack) throw new Error(`Stack with id ${nameOrId} does not exist`);
    if (stack.status === "CREATE_IN_PROGRESS") {
      stack.status = this.createOutcome === "rollback" ? "ROLLBACK_COMPLETE" : "CREATE_COMPLETE";
      if (this.createOutcome === "rollback") stack.reason = "The following resource(s) failed";
    } else if (stack.status === "DELETE_IN_PROGRESS") stack.status = "DELETE_COMPLETE";
    return {
      Stacks: [
        {
          StackId: stack.stackId,
          StackName: stack.name,
          StackStatus: stack.status,
          StackStatusReason: stack.reason,
          Tags: stack.tags,
          Outputs: [
            ...(this.flagOutput
              ? [{ OutputKey: "ParameterValue", OutputValue: fakeFlag(stack.name) }]
              : []),
            { OutputKey: "ParameterConsoleUrl", OutputValue: "https://console.example/p" },
          ],
        },
      ],
    };
  }
}
