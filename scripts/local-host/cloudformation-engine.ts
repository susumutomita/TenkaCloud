import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Capability,
  type CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import type { STSClient } from "@aws-sdk/client-sts";
import {
  buildParameterOverrides,
  generateRandomAlphanumeric,
} from "../../infrastructure/lib/problem-deploy/handlers/cfn-deploy-handler/parameter-overrides";
import { assumeRoleWithExternalId } from "../../infrastructure/lib/problem-deploy/handlers/shared/assume-competitor-role";
import {
  type Context,
  type EngineResult,
  HostError,
  type Job,
  type Problem,
  type RuntimeEngine,
  type Team,
} from "./model";

/** Short-lived credentials for the team's competitor role; the SDK refreshes them near expiry. */
export type CredentialsProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}>;

/** A problem deployed as one CloudFormation stack in each team's own AWS account. */
interface StackDefinition {
  kind: "cloudformation";
  problemId: string;
  templateBody: string;
  cfnParameters: Record<string, string>;
  /** The stack output holding the flag. Participants never see it through the host. */
  flagOutputKey: string;
}

/** Recorded before CreateStack, so an interrupted create can still be cleaned up. */
interface StackUnit {
  kind: "cloudformation";
  accountId: string;
  roleArn: string;
  region: string;
  stackName: string;
  stackId?: string;
  outputs?: Record<string, string>;
}

export interface CloudFormationEngineOptions {
  readonly region: string;
  /** The host's ExternalId. Every competitor role requires it (`competitor-bootstrap.yaml`). */
  readonly externalId: string;
  /** The account the host runs as. Problem templates trust it for participant access. */
  readonly operatorAccountId: () => Promise<string>;
  readonly sts: Pick<STSClient, "send">;
  readonly cloudFormation: (
    credentials: CredentialsProvider,
    region: string,
  ) => Pick<CloudFormationClient, "send">;
  readonly team: (job: Job) => Team;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly generateToken?: () => string;
}

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_=,.@:/-]{16,128}$/u;

/** Reviewed list: extending it requires reviewing the template's cost and blast radius. */
const REVIEWED_STACK_PROBLEMS = ["hello-world"];

export function cloudFormationCatalog(repositoryRoot: string): Problem[] {
  return REVIEWED_STACK_PROBLEMS.map((problemId) => {
    const directory = join(repositoryRoot, "problems/challenges", problemId);
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as {
      name: string;
      cfnTemplate: string;
      cfnParameters?: Record<string, string>;
      scoring: { kind: string; flagOutputKey?: string };
    };
    if (metadata.scoring.kind !== "flag" || !metadata.scoring.flagOutputKey)
      throw new Error(`${problemId}'s scoring contract changed; review cloud hosting support.`);
    const definition: StackDefinition = {
      kind: "cloudformation",
      problemId,
      templateBody: readFileSync(join(directory, metadata.cfnTemplate), "utf8"),
      cfnParameters: metadata.cfnParameters ?? {},
      flagOutputKey: metadata.scoring.flagOutputKey,
    };
    return {
      problemId,
      name: metadata.name,
      definition: JSON.stringify(definition),
      runtime: "cloudformation",
    };
  });
}

export class CloudFormationEngine implements RuntimeEngine {
  private readonly problems: readonly Problem[];

  constructor(
    repositoryRoot: string,
    private readonly options: CloudFormationEngineOptions,
  ) {
    if (!EXTERNAL_ID_PATTERN.test(options.externalId))
      throw new Error("The host ExternalId must be 16–128 characters of [A-Za-z0-9_=,.@:/-].");
    this.problems = cloudFormationCatalog(repositoryRoot);
  }

  catalog(): readonly Problem[] {
    return this.problems;
  }

  requiresGateway(): boolean {
    return false;
  }

  hostPorts(): readonly number[] {
    return [];
  }

  async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    const definition = JSON.parse(job.definition) as StackDefinition;
    const team = this.options.team(job);
    if (!team.aws) throw new HostError(422, `Team ${team.internalSlug} has no AWS account.`);
    const namePrefix = `tc-${definition.problemId}-${team.internalSlug}`;
    const unit: StackUnit = {
      kind: "cloudformation",
      accountId: team.aws.accountId,
      roleArn: `arn:aws:iam::${team.aws.accountId}:role/${team.aws.roleName}`,
      region: this.options.region,
      stackName: namePrefix,
    };
    retain(JSON.stringify(unit));
    const client = this.client(unit, job);
    const created = await client.send(
      new CreateStackCommand({
        StackName: unit.stackName,
        TemplateBody: definition.templateBody,
        Parameters: buildParameterOverrides({
          cfnParameters: definition.cfnParameters,
          namePrefix,
          tenkaCloudAccountId: await this.options.operatorAccountId(),
          externalId: job.jobId,
          generateToken: this.options.generateToken ?? (() => generateRandomAlphanumeric()),
          templateBody: definition.templateBody,
        }),
        Capabilities: [Capability.CAPABILITY_NAMED_IAM],
        Tags: [{ Key: "tenkacloud:job", Value: job.jobId }],
      }),
    );
    unit.stackId = created.StackId;
    retain(JSON.stringify(unit));
    const stack = await this.settle(client, unit, "CREATE_COMPLETE");
    unit.outputs = Object.fromEntries(
      (stack?.Outputs ?? []).map((output) => [output.OutputKey ?? "", output.OutputValue ?? ""]),
    );
    retain(JSON.stringify(unit));
  }

  async recover(job: Job): Promise<void> {
    const unit = unitOf(job);
    const stack = await this.describe(this.client(unit, job), unit);
    if (stack?.StackStatus !== "CREATE_COMPLETE")
      throw new Error(`Stack ${unit.stackName} is ${stack?.StackStatus ?? "gone"}.`);
  }

  async stop(job: Job): Promise<void> {
    const unit = unitOf(job);
    const client = this.client(unit, job);
    if (!(await this.describe(client, unit))) return;
    await client.send(new DeleteStackCommand({ StackName: unit.stackId ?? unit.stackName }));
    await this.settle(client, unit, "DELETE_COMPLETE");
  }

  async pause(): Promise<void> {
    throw new HostError(409, "A cloud environment cannot be paused. Tear it down instead.");
  }

  async resume(job: Job): Promise<void> {
    await this.recover(job);
  }

  /** The stack's console page, in the team's own account. */
  surface(job: Job): string {
    const unit = unitOf(job);
    const region = encodeURIComponent(unit.region);
    const base = `https://${unit.region}.console.aws.amazon.com/cloudformation/home?region=${region}`;
    return unit.stackId
      ? `${base}#/stacks/stackinfo?stackId=${encodeURIComponent(unit.stackId)}`
      : `${base}#/stacks?filteringText=${encodeURIComponent(unit.stackName)}`;
  }

  async view(context: Context): Promise<Record<string, unknown>> {
    return {
      problems: context.jobs.map((job) => {
        const definition = JSON.parse(job.definition) as StackDefinition;
        const outputs = job.unit ? (unitOf(job).outputs ?? {}) : {};
        return {
          problemId: job.problemId,
          status: job.status,
          outputs: Object.fromEntries(
            Object.entries(outputs).filter(([key]) => key !== definition.flagOutputKey),
          ),
        };
      }),
    };
  }

  async submit(): Promise<EngineResult> {
    throw new HostError(501, "Answer checking for cloud problems is not available yet.");
  }

  async hint(): Promise<EngineResult> {
    throw new HostError(501, "Hints for cloud problems are not available yet.");
  }

  private client(unit: StackUnit, job: Job): Pick<CloudFormationClient, "send"> {
    const credentials: CredentialsProvider = async () => {
      const assumed = await assumeRoleWithExternalId(
        { sts: this.options.sts },
        {
          roleArn: unit.roleArn,
          jobId: job.jobId,
          externalId: this.options.externalId,
          sessionNamePrefix: "tenkacloud-host-",
        },
      );
      return {
        accessKeyId: assumed.AccessKeyId as string,
        secretAccessKey: assumed.SecretAccessKey as string,
        sessionToken: assumed.SessionToken,
        expiration: assumed.Expiration,
      };
    };
    return this.options.cloudFormation(credentials, unit.region);
  }

  private async describe(
    client: Pick<CloudFormationClient, "send">,
    unit: StackUnit,
  ): Promise<Stack | undefined> {
    try {
      const out = await client.send(
        new DescribeStacksCommand({ StackName: unit.stackId ?? unit.stackName }),
      );
      const stack = out.Stacks?.[0];
      return stack?.StackStatus === "DELETE_COMPLETE" ? undefined : stack;
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not exist")) return undefined;
      throw error;
    }
  }

  private async settle(
    client: Pick<CloudFormationClient, "send">,
    unit: StackUnit,
    goal: "CREATE_COMPLETE" | "DELETE_COMPLETE",
  ): Promise<Stack | undefined> {
    const deadline = Date.now() + this.options.timeoutMs;
    for (;;) {
      const stack = await this.describe(client, unit);
      if (!stack) {
        if (goal === "DELETE_COMPLETE") return undefined;
        throw new Error(`Stack ${unit.stackName} disappeared while it was being created.`);
      }
      if (stack.StackStatus === goal) return stack;
      if (!stack.StackStatus?.endsWith("_IN_PROGRESS"))
        throw new Error(
          `Stack ${unit.stackName} ended ${stack.StackStatus}: ${stack.StackStatusReason ?? "no reason given"}.`,
        );
      if (Date.now() >= deadline)
        throw new Error(`Stack ${unit.stackName} is still ${stack.StackStatus} after the timeout.`);
      await this.options.sleep(this.options.pollIntervalMs);
    }
  }
}

function unitOf(job: Job): StackUnit {
  if (!job.unit) throw new Error(`Job ${job.jobId} owns no stack.`);
  return JSON.parse(job.unit) as StackUnit;
}
