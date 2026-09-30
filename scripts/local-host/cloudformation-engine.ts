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
import type { ParticipantProblemView } from "@tenkacloud/portal-contracts";
import {
  buildParameterOverrides,
  generateRandomAlphanumeric,
} from "../../infrastructure/lib/problem-deploy/handlers/cfn-deploy-handler/parameter-overrides";
import { flagMatches } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/flag";
import { assumeRoleWithExternalId } from "../../infrastructure/lib/problem-deploy/handlers/shared/assume-competitor-role";
import { hintViews } from "../local-play/api-views";
import {
  type ContainerVerifyScoring,
  parseEnglishOverlay,
  parseVerifyScoring,
} from "../local-play/manifest";
import {
  type AwsTarget,
  type Context,
  type EngineResult,
  HostError,
  isSolve,
  type Job,
  type Problem,
  type RuntimeEngine,
  type ScoreEvent,
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
  name: string;
  instructions: string;
  /** English overlay without the author-only description. */
  english?: { name?: string; instructions?: string };
  scoring: Omit<ContainerVerifyScoring, "kind">;
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
      instructions: string;
      cfnTemplate: string;
      cfnParameters?: Record<string, string>;
      scoring: { kind: string; flagOutputKey?: string } & Record<string, unknown>;
      i18n?: { en?: Record<string, unknown> };
    };
    if (metadata.scoring.kind !== "flag" || !metadata.scoring.flagOutputKey)
      throw new Error(`${problemId}'s scoring contract changed; review cloud hosting support.`);
    const overlay = parseEnglishOverlay(metadata.i18n);
    const { points, wrongAnswerPenalty, hints, hintReveal } = parseVerifyScoring(
      metadata.scoring,
      overlay.hintById,
    );
    // Picked, not filtered: the author-only description never reaches participants.
    const english = {
      ...(overlay.text?.name ? { name: overlay.text.name } : {}),
      ...(overlay.text?.instructions ? { instructions: overlay.text.instructions } : {}),
    };
    const definition: StackDefinition = {
      kind: "cloudformation",
      problemId,
      templateBody: readFileSync(join(directory, metadata.cfnTemplate), "utf8"),
      cfnParameters: metadata.cfnParameters ?? {},
      flagOutputKey: metadata.scoring.flagOutputKey,
      name: metadata.name,
      instructions: metadata.instructions,
      ...(Object.keys(english).length > 0 ? { english } : {}),
      scoring: { points, wrongAnswerPenalty, hints, ...(hintReveal ? { hintReveal } : {}) },
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
    const aws = awsTargetOf(team);
    // A job gets its own names even when another event uses the same team account and slug.
    const namePrefix = `tc-${definition.problemId}-${team.internalSlug}-${job.jobId.slice(-12).toLowerCase()}`;
    const unit: StackUnit = {
      kind: "cloudformation",
      accountId: aws.accountId,
      roleArn: `arn:aws:iam::${aws.accountId}:role/${aws.roleName}`,
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
    const stack = await this.settle(client, unit, job.jobId, "CREATE_COMPLETE");
    unit.outputs = Object.fromEntries(
      (stack?.Outputs ?? []).map((output) => [output.OutputKey ?? "", output.OutputValue ?? ""]),
    );
    unit.stackId ??= stack?.StackId;
    retain(JSON.stringify(unit));
    if (!unit.outputs[definition.flagOutputKey]?.trim())
      throw new Error(`Stack ${unit.stackName} has no ${definition.flagOutputKey} flag output.`);
  }

  async recover(job: Job): Promise<void> {
    const unit = unitOf(job);
    const stack = await this.describe(this.client(unit, job), unit, job.jobId);
    if (stack?.StackStatus !== "CREATE_COMPLETE")
      throw new Error(`Stack ${unit.stackName} is ${stack?.StackStatus ?? "gone"}.`);
    const definition = JSON.parse(job.definition) as StackDefinition;
    if (!unit.outputs?.[definition.flagOutputKey]?.trim())
      throw new Error(
        `Stack ${unit.stackName} has no retained ${definition.flagOutputKey} flag output.`,
      );
  }

  async stop(job: Job): Promise<void> {
    const unit = unitOf(job);
    const client = this.client(unit, job);
    const stack = await this.describe(client, unit, job.jobId);
    if (!stack) return;
    if (!stack.StackId) throw new Error(`Stack ${unit.stackName} has no ID; refusing deletion.`);
    unit.stackId = stack.StackId;
    await client.send(new DeleteStackCommand({ StackName: stack.StackId }));
    await this.settle(client, unit, job.jobId, "DELETE_COMPLETE");
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
      problems: context.event.problems.map((problem) => this.problemView(context, problem)),
    };
  }

  /**
   * The participant portal's single-flag entry (`ParticipantProblemView`). `HostingService`
   * adds what it sets for every runtime: job ID, status, provider and expiry.
   */
  private problemView(
    context: Context,
    problem: Problem,
  ): Omit<ParticipantProblemView, "jobId" | "status" | "provider" | "expiresAt"> {
    const definition = JSON.parse(problem.definition) as StackDefinition;
    const job = context.jobs.find((candidate) => candidate.problemId === problem.problemId);
    const unit = job?.unit ? unitOf(job) : undefined;
    const events = context.team.scoreEvents.filter(
      (event) => event.problemId === problem.problemId,
    );
    const solved = events.some(isSolve);
    return {
      problemId: problem.problemId,
      name: definition.name,
      instructions: definition.instructions,
      ...(definition.english ? { i18n: { en: definition.english } } : {}),
      region: unit?.region ?? this.options.region,
      awsAccountId: awsTargetOf(context.team).accountId,
      stackOutputs: Object.fromEntries(
        Object.entries(unit?.outputs ?? {}).filter(([key]) => key !== definition.flagOutputKey),
      ),
      score: events.reduce((sum, event) => sum + event.points, 0),
      ...(solved ? { lastResult: "ok" as const } : {}),
      scoring: {
        kind: "flag",
        points: definition.scoring.points,
        flagSubmitted: solved,
        hints: hintViews(revealedHints(events), definition.scoring.hints),
        ...(definition.scoring.hintReveal ? { hintReveal: definition.scoring.hintReveal } : {}),
      },
      deployLog: { cursor: "", entries: [] },
    };
  }

  /** Scored against the flag output retained at deploy time; nothing is read from AWS. */
  async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const deployed = this.deployed(context, String(body.problemId));
    const { team } = context;
    if (deployed.events.some(isSolve))
      return outcome(team, { kind: "already_scored", totalScore: team.score });
    const outputs = deployed.job.unit ? unitOf(deployed.job).outputs : undefined;
    const expected = outputs?.[deployed.definition.flagOutputKey];
    if (!expected?.trim())
      throw new HostError(
        409,
        "This team's stack has no flag output yet. Ask the organizer to redeploy it.",
        "not_deployed",
      );
    const scoring = deployed.definition.scoring;
    if (flagMatches(String(body.flag), expected)) {
      const event = deployed.record("flag", scoring.points, "ok");
      return outcome(
        team,
        { kind: "ok", scoreDelta: event.points, totalScore: team.score + event.points },
        event,
      );
    }
    const event = deployed.record(
      "flag-wrong",
      scoring.wrongAnswerPenalty ? -scoring.wrongAnswerPenalty : 0,
      "wrong",
    );
    return outcome(
      team,
      {
        kind: "wrong",
        scoreDelta: event.points,
        totalScore: team.score + event.points,
        wrongCount: deployed.events.filter((each) => each.source === "flag-wrong").length + 1,
      },
      event,
    );
  }

  async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const deployed = this.deployed(context, problemId);
    const hint = deployed.definition.scoring.hints.find((candidate) => candidate.id === hintId);
    if (!hint) throw new HostError(404, "This problem has no such hint.", "unknown_hint");
    const { team } = context;
    const text = { content: hint.content, ...(hint.i18n ? { i18n: hint.i18n } : {}) };
    const revealedAt = revealedHints(deployed.events).get(hint.id);
    if (revealedAt)
      return outcome(team, {
        kind: "already_revealed",
        ...text,
        penaltyApplied: 0,
        totalScore: team.score,
        revealedAt,
      });
    const event = {
      ...deployed.record("hint", hint.penalty ? -hint.penalty : 0, "ok"),
      hintId: hint.id,
    };
    return outcome(
      team,
      {
        kind: "ok",
        ...text,
        penaltyApplied: hint.penalty,
        totalScore: team.score + event.points,
        revealedAt: event.occurredAt,
      },
      event,
    );
  }

  /** The team's running stack for `problemId`, its score events, and a recorder for new ones. */
  private deployed(context: Context, problemId: string) {
    const problem = context.event.problems.find((candidate) => candidate.problemId === problemId);
    if (!problem) throw new HostError(404, "This event has no such problem.", "unknown_problem");
    const job = context.jobs.find(
      (candidate) => candidate.problemId === problemId && candidate.status === "COMPLETE",
    );
    if (!job) throw new HostError(409, "This team's stack is not deployed.", "not_deployed");
    const occurredAt = new Date(context.now).toISOString();
    return {
      definition: JSON.parse(problem.definition) as StackDefinition,
      job,
      events: context.team.scoreEvents.filter((event) => event.problemId === problemId),
      record: (source: string, points: number, result: ScoreEvent["result"]): ScoreEvent => ({
        jobId: job.jobId,
        problemId,
        source,
        points,
        result,
        occurredAt,
      }),
    };
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
    jobId: string,
  ): Promise<Stack | undefined> {
    try {
      const out = await client.send(
        new DescribeStacksCommand({ StackName: unit.stackId ?? unit.stackName }),
      );
      const stack = out.Stacks?.[0];
      if (!stack || stack.StackStatus === "DELETE_COMPLETE") return undefined;
      const owned =
        stack.StackName === unit.stackName &&
        stack.Tags?.some((tag) => tag.Key === "tenkacloud:job" && tag.Value === jobId);
      if (!owned) {
        if (!unit.stackId) return undefined;
        throw new Error(`Stack ${unit.stackName} does not belong to job ${jobId}.`);
      }
      if (unit.stackId && stack.StackId !== unit.stackId)
        throw new Error(`Stack ${unit.stackName} changed ID; refusing to use it for job ${jobId}.`);
      return stack;
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not exist")) return undefined;
      throw error;
    }
  }

  private async settle(
    client: Pick<CloudFormationClient, "send">,
    unit: StackUnit,
    jobId: string,
    goal: "CREATE_COMPLETE" | "DELETE_COMPLETE",
  ): Promise<Stack | undefined> {
    const deadline = Date.now() + this.options.timeoutMs;
    for (;;) {
      const stack = await this.describe(client, unit, jobId);
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

function awsTargetOf(team: Team): AwsTarget {
  if (!team.aws) throw new HostError(422, `Team ${team.internalSlug} has no AWS account.`);
  return team.aws;
}

function revealedHints(events: readonly ScoreEvent[]): ReadonlyMap<string, string> {
  return new Map(
    events.flatMap((event) =>
      event.source === "hint" && event.hintId ? [[event.hintId, event.occurredAt]] : [],
    ),
  );
}

/**
 * The team after one cloud action. Docker's snapshot is not touched, and the totals move by
 * exactly the new event, so points from other runtimes are kept as they are.
 */
function outcome(team: Team, body: Record<string, unknown>, event?: ScoreEvent): EngineResult {
  return {
    status: 200,
    body,
    snapshot: team.snapshot,
    score: team.score + (event?.points ?? 0),
    completedProblems: team.completedProblems + (event && isSolve(event) ? 1 : 0),
    scoreEvents: event ? [event, ...team.scoreEvents] : team.scoreEvents,
  };
}
