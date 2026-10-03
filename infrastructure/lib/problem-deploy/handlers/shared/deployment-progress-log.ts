import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

interface LogSender {
  send(command: object): Promise<unknown>;
}

export type DeploymentProgressWriter = (jobId: string, message: string) => Promise<void>;

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ResourceAlreadyExistsException" || /already exists/i.test(error.message))
  );
}

/**
 * Write participant-safe progress to a deterministic CloudWatch Logs stream named by jobId.
 * Logging is fail-open: a Logs throttle must not turn a valid CloudFormation operation into a
 * failed deployment.
 */
export function buildDeploymentProgressWriter(
  logs: LogSender,
  logGroupName: string | undefined,
): DeploymentProgressWriter {
  return async (jobId, message) => {
    if (!logGroupName) return;
    try {
      try {
        await logs.send(
          new CreateLogStreamCommand({
            logGroupName,
            logStreamName: jobId,
          }),
        );
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await logs.send(
        new PutLogEventsCommand({
          logGroupName,
          logStreamName: jobId,
          logEvents: [{ timestamp: Date.now(), message }],
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "deploy.progress-log.failed",
          jobId,
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  };
}

const logs = new CloudWatchLogsClient({});

export const writeDeploymentProgress = buildDeploymentProgressWriter(
  logs,
  process.env.DEPLOYMENT_LOG_GROUP_NAME,
);
