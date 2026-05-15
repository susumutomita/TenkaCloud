import type { StackEvent } from "@aws-sdk/client-cloudformation";

export interface StackStuckDiagnosis {
  readonly isStuck: true;
  readonly elapsedMinutes: number;
  readonly observedAt: string;
  readonly reason: string;
  readonly remediationHint: string;
  readonly resourceLogicalId?: string;
  readonly resourceType?: string;
  readonly resourceStatus?: string;
}

const STUCK_AFTER_MS = 30 * 60 * 1000;
const IN_PROGRESS_STACK_STATUSES = new Set([
  "CREATE_IN_PROGRESS",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "DELETE_IN_PROGRESS",
  "REVIEW_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "IMPORT_ROLLBACK_IN_PROGRESS",
]);

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function buildRemediationHint(stackStatus: string, reason: string): string {
  const text = `${stackStatus} ${reason}`.toLowerCase();
  if (text.includes("accessdenied") || text.includes("not authorized")) {
    return "Check the competitor account role permissions and ExternalId, then retry the deployment.";
  }
  if (text.includes("quota") || text.includes("limit exceeded") || text.includes("service limit")) {
    return "Request a service quota increase or delete unused resources, then retry the deployment.";
  }
  if (text.includes("already exists") || text.includes("already exist")) {
    return "Resolve the resource name collision or delete the conflicting resource, then retry.";
  }
  if (text.includes("timeout") || text.includes("timed out") || text.includes("stabiliz")) {
    return "Inspect the resource stabilization failure in CloudFormation events, fix the underlying resource, then retry.";
  }
  if (stackStatus.includes("ROLLBACK")) {
    return "Wait for rollback to finish, inspect the first failed resource event, fix the cause, then retry.";
  }
  if (stackStatus === "DELETE_IN_PROGRESS") {
    return "Inspect delete-blocking resources in CloudFormation events; remove dependencies or retained resources, then retry teardown.";
  }
  return "Open the CloudFormation console, inspect the latest StackEvents for the blocking resource, fix the cause, then retry.";
}

export function buildCfnStuckDiagnosis(args: {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly events: readonly StackEvent[];
  readonly stackName: string;
  readonly stackStatus: string | undefined;
  readonly now: Date;
}): StackStuckDiagnosis | undefined {
  const stackStatus = args.stackStatus;
  if (!stackStatus || !IN_PROGRESS_STACK_STATUSES.has(stackStatus)) return undefined;

  const latestEventAt = args.events.find((e) => e.Timestamp)?.Timestamp;
  const startedAt = latestEventAt ?? parseDate(args.updatedAt) ?? parseDate(args.createdAt);
  if (!startedAt) return undefined;

  const elapsedMs = args.now.getTime() - startedAt.getTime();
  if (elapsedMs < STUCK_AFTER_MS) return undefined;

  const reasonEvent =
    args.events.find((e) => e.ResourceStatus?.endsWith("_FAILED") && e.ResourceStatusReason) ??
    args.events.find(
      (e) =>
        e.LogicalResourceId !== args.stackName &&
        typeof e.ResourceStatusReason === "string" &&
        e.ResourceStatusReason.length > 0,
    ) ??
    args.events.find((e) => typeof e.ResourceStatusReason === "string");

  const reason =
    reasonEvent?.ResourceStatusReason ??
    `${stackStatus} has not emitted new CloudFormation events for ${Math.floor(elapsedMs / 60000)} minutes.`;

  return {
    isStuck: true,
    elapsedMinutes: Math.floor(elapsedMs / 60000),
    observedAt: args.now.toISOString(),
    reason,
    remediationHint: buildRemediationHint(stackStatus, reason),
    resourceLogicalId: reasonEvent?.LogicalResourceId,
    resourceType: reasonEvent?.ResourceType,
    resourceStatus: reasonEvent?.ResourceStatus,
  };
}
