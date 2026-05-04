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
 * CFn StackStatus → 内部 DeploymentStatus の遷移を計算する。
 *
 * 入力:
 *   - currentStatus: DDB に保存された現在の DeploymentStatus
 *   - cfnStack: DescribeStacks の結果 (StackStatus / StackStatusReason / Outputs)
 *
 * 出力:
 *   - kind="transition": 状態遷移すべき (DDB Update + Event publish)
 *   - kind="stable": 遷移なし (無視)
 *
 * StackStatus が認識できない場合は stable を返して既存状態を維持する (CFn が新しい
 * status を追加した時に worker が誤判定で FAILED に倒さないように)。
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
  if (IN_PROGRESS_STATUSES.has(cfnStatus)) {
    // CFn 側でまだ進行中 (CREATE_IN_PROGRESS など) は in-flight 扱い、内部状態は維持
    return { kind: "stable" };
  }
  return { kind: "stable" };
}

/**
 * CFn の Outputs (Array<Output>) を `OutputKey -> OutputValue` の JSON 文字列に直す。
 * UI / participant portal が parse して `FrontendUrl` などを取り出す想定。
 */
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
