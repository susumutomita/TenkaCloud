import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  type OutputLogEvent,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import { BatchGetBuildsCommand, type Build, CodeBuildClient } from "@aws-sdk/client-codebuild";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 4_000;

const CODEBUILD_TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "FAULT",
  "STOPPED",
  "TIMED_OUT",
]);
const DEPLOYMENT_TERMINAL_STATUSES = new Set<DeploymentStatus>(["COMPLETE", "FAILED", "DELETED"]);

export interface ParticipantDeployLogEntry {
  readonly id: string;
  readonly timestamp: string;
  /**
   * `"codebuild"` = CodeBuild 経路の deploy build log。 `"lambda"` = deployViaLambda ON (#2291) の
   * jobId 名 CloudWatch stream 由来 (CodeBuild build が無いケース)。
   */
  readonly source: "codebuild" | "lambda";
  readonly message: string;
}

export interface ParticipantDeployLogsResponse {
  readonly jobId: string;
  readonly buildStatus?: string;
  readonly complete: boolean;
  readonly nextToken?: string;
  readonly entries: readonly ParticipantDeployLogEntry[];
}

export type ParticipantDeployLogsOutcome =
  | { readonly kind: "ok"; readonly response: ParticipantDeployLogsResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not_found" };

interface DeployLogParams {
  readonly jobId: string;
  readonly nextToken?: string;
  readonly limit?: number;
}

interface AwsSender {
  send(command: object): Promise<unknown>;
}

export interface DeployLogDeps {
  readonly codebuild: AwsSender;
  readonly logs: AwsSender;
}

export const defaultDeployLogDeps: DeployLogDeps = {
  codebuild: new CodeBuildClient({}),
  logs: new CloudWatchLogsClient({}),
};

export function parseDeployLogLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

export async function getParticipantDeployLogs(
  shared: ParticipantSharedResources,
  deps: DeployLogDeps,
  teamLoginKey: string,
  params: DeployLogParams,
): Promise<ParticipantDeployLogsOutcome> {
  const teamItems = await queryTeamItems(shared, teamLoginKey);
  if (teamItems.length === 0) return { kind: "unauthorized" };

  const deployment = teamItems.find((item) => item.jobId === params.jobId);
  if (!deployment) return { kind: "not_found" };

  const deploymentStatus = (deployment.status ?? "PENDING") as DeploymentStatus;
  const buildId = typeof deployment.buildId === "string" ? deployment.buildId : "";
  const problemId = typeof deployment.problemId === "string" ? deployment.problemId : "";
  if (buildId.length === 0) {
    // Issue #2291: on the Lambda deploy path there is no CodeBuild build; the deploy Lambda writes
    // progress to a jobId-keyed stream in DEPLOY_JOB_LOG_GROUP. Read that when the env is set;
    // otherwise keep today's exact behavior (empty entries) so the flag-OFF path is unchanged.
    const jobLogGroup = process.env.DEPLOY_JOB_LOG_GROUP;
    if (jobLogGroup) {
      return getLambdaPathDeployLogs(deps, {
        logGroupName: jobLogGroup,
        jobId: params.jobId,
        nextToken: params.nextToken,
        limit: params.limit ?? DEFAULT_LIMIT,
        deploymentStatus,
        problemId,
        scoringMap: shared.problemsScoring ?? {},
      });
    }
    return {
      kind: "ok",
      response: {
        jobId: params.jobId,
        buildStatus: deploymentStatus,
        complete: DEPLOYMENT_TERMINAL_STATUSES.has(deploymentStatus),
        entries: [],
      },
    };
  }

  const build = await getBuild(deps, buildId);
  const buildStatus = build?.buildStatus;
  const logGroupName = build?.logs?.groupName;
  const logStreamName = build?.logs?.streamName;
  if (!logGroupName || !logStreamName) {
    return {
      kind: "ok",
      response: {
        jobId: params.jobId,
        buildStatus,
        complete: isComplete(buildStatus, deploymentStatus),
        entries: [],
      },
    };
  }

  const out = (await deps.logs.send(
    new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      nextToken: params.nextToken,
      limit: params.limit ?? DEFAULT_LIMIT,
      startFromHead: true,
    }),
  )) as { events?: OutputLogEvent[]; nextForwardToken?: string };

  return {
    kind: "ok",
    response: {
      jobId: params.jobId,
      buildStatus,
      complete: isComplete(buildStatus, deploymentStatus),
      nextToken: out.nextForwardToken,
      entries: (out.events ?? []).map((event, index) =>
        toDeployLogEntry(event, index, problemId, shared.problemsScoring ?? {}, "codebuild"),
      ),
    },
  };
}

interface LambdaPathLogArgs {
  readonly logGroupName: string;
  readonly jobId: string;
  readonly nextToken?: string;
  readonly limit: number;
  readonly deploymentStatus: DeploymentStatus;
  readonly problemId: string;
  readonly scoringMap: Record<string, ProblemScoringMetadata>;
}

/**
 * Issue #2291: stream deploy progress from the Lambda path's jobId-keyed CloudWatch stream. `source`
 * is `"lambda"`. Redaction + truncation are applied identically to the CodeBuild path (invariant).
 * A stream that does not exist yet (deploy just started) surfaces as `ResourceNotFoundException`,
 * which we normalize to an empty-but-OK response rather than an error.
 */
async function getLambdaPathDeployLogs(
  deps: DeployLogDeps,
  args: LambdaPathLogArgs,
): Promise<ParticipantDeployLogsOutcome> {
  const complete = DEPLOYMENT_TERMINAL_STATUSES.has(args.deploymentStatus);
  try {
    const out = (await deps.logs.send(
      new GetLogEventsCommand({
        logGroupName: args.logGroupName,
        logStreamName: args.jobId,
        nextToken: args.nextToken,
        limit: args.limit,
        startFromHead: true,
      }),
    )) as { events?: OutputLogEvent[]; nextForwardToken?: string };
    return {
      kind: "ok",
      response: {
        jobId: args.jobId,
        buildStatus: args.deploymentStatus,
        complete,
        nextToken: out.nextForwardToken,
        entries: (out.events ?? []).map((event, index) =>
          toDeployLogEntry(event, index, args.problemId, args.scoringMap, "lambda"),
        ),
      },
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      // Stream not created yet — the deploy Lambda writes it lazily on first progress line.
      return {
        kind: "ok",
        response: {
          jobId: args.jobId,
          buildStatus: args.deploymentStatus,
          complete,
          entries: [],
        },
      };
    }
    throw err;
  }
}

async function getBuild(deps: DeployLogDeps, buildId: string): Promise<Build | undefined> {
  const out = (await deps.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }))) as {
    builds?: Build[];
  };
  return out.builds?.[0];
}

function isComplete(buildStatus: string | undefined, deploymentStatus: DeploymentStatus): boolean {
  if (buildStatus && CODEBUILD_TERMINAL_STATUSES.has(buildStatus)) return true;
  return DEPLOYMENT_TERMINAL_STATUSES.has(deploymentStatus);
}

function toDeployLogEntry(
  event: OutputLogEvent,
  index: number,
  problemId: string,
  scoringMap: Record<string, ProblemScoringMetadata>,
  source: "codebuild" | "lambda",
): ParticipantDeployLogEntry {
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
  const ingestionTime = typeof event.ingestionTime === "number" ? event.ingestionTime : 0;
  return {
    id: `${timestamp}:${ingestionTime}:${index}`,
    timestamp: timestamp > 0 ? new Date(timestamp).toISOString() : "",
    source,
    message: truncateMessage(redactLogMessage(event.message ?? "", problemId, scoringMap)),
  };
}

function redactLogMessage(
  message: string,
  problemId: string,
  scoringMap: Record<string, ProblemScoringMetadata>,
): string {
  const scoring = scoringMap[problemId];
  if (scoring?.kind === "flag" && message.includes(scoring.flagOutputKey)) {
    return "[redacted scoring output]";
  }
  if (/\b(password|secret|token|externalid)\b/i.test(message)) {
    return "[redacted sensitive output]";
  }
  return message;
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH)}... [truncated]`;
}
