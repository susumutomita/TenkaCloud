import type { Output, Stack } from "@aws-sdk/client-cloudformation";

export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export type ResolvedStatus =
  | { kind: "transition"; status: Exclude<DeploymentStatus, "PENDING">; failureReason?: string }
  | { kind: "stable" };

const COMPLETE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);
const FAILED_STATUSES = new Set([
  "CREATE_FAILED",
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_COMPLETE",
  "UPDATE_ROLLBACK_FAILED",
  "DELETE_FAILED",
]);
const DELETED_STATUSES = new Set(["DELETE_COMPLETE"]);
const IN_PROGRESS_STATUSES = new Set([
  "CREATE_IN_PROGRESS",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "DELETE_IN_PROGRESS",
  "REVIEW_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_IN_PROGRESS",
  "IMPORT_ROLLBACK_FAILED",
  "IMPORT_ROLLBACK_COMPLETE",
]);

/**
 * 認識できない StackStatus は `stable` を返す (CFn が将来的に追加する新規 status を
 * 既存ロジックが誤判定で FAILED に倒すのを防ぐ)。
 */
export function resolveDeploymentStatus(
  currentStatus: DeploymentStatus,
  cfnStatus: string | undefined,
  stackStatusReason: string | undefined,
): ResolvedStatus {
  if (!cfnStatus) return { kind: "stable" };

  if (DELETED_STATUSES.has(cfnStatus)) {
    if (currentStatus === "DELETED") return { kind: "stable" };
    return { kind: "transition", status: "DELETED" };
  }
  if (COMPLETE_STATUSES.has(cfnStatus)) {
    if (currentStatus === "COMPLETE") return { kind: "stable" };
    return { kind: "transition", status: "COMPLETE" };
  }
  if (FAILED_STATUSES.has(cfnStatus)) {
    if (currentStatus === "FAILED") return { kind: "stable" };
    return {
      kind: "transition",
      status: "FAILED",
      failureReason: stackStatusReason ? `${cfnStatus}: ${stackStatusReason}` : cfnStatus,
    };
  }
  if (IN_PROGRESS_STATUSES.has(cfnStatus)) return { kind: "stable" };
  return { kind: "stable" };
}

export function serializeStackOutputs(outputs: Output[] | undefined): string {
  if (!outputs?.length) return "{}";
  const obj: Record<string, string> = {};
  for (const o of outputs) {
    if (o.OutputKey && o.OutputValue !== undefined) {
      obj[o.OutputKey] = o.OutputValue;
    }
  }
  return JSON.stringify(obj);
}

export function extractStackContext(stack: Stack | undefined): {
  cfnStatus: string | undefined;
  stackStatusReason: string | undefined;
  outputs: Output[] | undefined;
} {
  if (!stack) return { cfnStatus: undefined, stackStatusReason: undefined, outputs: undefined };
  return {
    cfnStatus: stack.StackStatus,
    stackStatusReason: stack.StackStatusReason,
    outputs: stack.Outputs,
  };
}
