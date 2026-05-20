/**
 * DeploymentDetail を Netlify 風の 5 phase に変換するロジック。
 *
 * 既存の backend を変えずに、`DeploymentSummary` + `StackProgress` だけから派生する。
 * Phase の status は次の順で決まる:
 *   1. Enqueued — deployment row が存在すれば必ず Complete (= 観測時点で row はある)
 *   2. Building — CodeBuild step の代理。stack events / resources が 1 件でも観測されたら
 *      Complete、まだなら IN_PROGRESS は In Progress、FAILED + 観測なし は Failed。
 *   3. CloudFormation Deploy — events を見て判定。すべて `_COMPLETE` なら Complete、
 *      `_FAILED` を含めば Failed、`_IN_PROGRESS` を含めば In Progress、空なら Pending。
 *   4. Health Check — placeholder。常に Skipped (= 将来の Lambda 連携枠)。
 *   5. Complete / Teardown — deployment.status を素直に反映。
 *
 * Backend を変えない frontend-only の派生なので、ここに集約することで View 側を薄く保つ。
 */

import type {
  DeploymentStatus,
  DeploymentSummary,
  StackProgress,
  StackProgressEvent,
} from "../api/deploy-client";

export type PhaseStatus = "complete" | "in-progress" | "failed" | "skipped" | "pending";

export type PhaseId = "enqueued" | "building" | "cfn-deploy" | "health-check" | "complete";

export interface DeployPhase {
  readonly id: PhaseId;
  readonly name: string;
  readonly status: PhaseStatus;
  /** Phase の中身を組み立てるためのヒント。View 側はこの id で switch する。 */
  readonly note?: string;
}

const COMPLETE_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

/**
 * Issue #818: stackStatus (= 現在の stack 状態) を権威 source として優先する。
 * 旧 \`eventsToPhaseStatus\` は CFn event history の **過去** \`*_IN_PROGRESS\` event
 * も拾うため、 stack が CREATE_COMPLETE になっても in-progress のままになる bug が
 * あった。
 */
function stackStatusToPhaseStatus(stackStatus: string | undefined): PhaseStatus | undefined {
  if (!stackStatus) return undefined;
  if (stackStatus === "CREATE_COMPLETE") return "complete";
  if (stackStatus === "UPDATE_COMPLETE") return "complete";
  if (stackStatus === "IMPORT_COMPLETE") return "complete";
  if (stackStatus.endsWith("_FAILED")) return "failed";
  if (stackStatus === "ROLLBACK_COMPLETE") return "failed";
  if (stackStatus === "UPDATE_ROLLBACK_COMPLETE") return "failed";
  if (stackStatus === "IMPORT_ROLLBACK_COMPLETE") return "failed";
  if (stackStatus.startsWith("DELETE_")) return "skipped";
  if (stackStatus.endsWith("_IN_PROGRESS")) return "in-progress";
  return undefined;
}

/**
 * Issue #818: LogicalId ごとに最新 event だけを判定対象にする (= 過去の
 * IN_PROGRESS が COMPLETE で superseded されている状態を正しく扱う)。 旧
 * \`events.some(IN_PROGRESS)\` は history 全体を拾って永遠に in-progress を
 * 返していた。
 */
function eventsToPhaseStatus(events: readonly StackProgressEvent[]): PhaseStatus {
  if (events.length === 0) return "pending";
  const latestByLogicalId = new Map<string, StackProgressEvent>();
  for (const e of events) {
    const cur = latestByLogicalId.get(e.logicalResourceId);
    if (!cur || cur.timestamp < e.timestamp) {
      latestByLogicalId.set(e.logicalResourceId, e);
    }
  }
  const latest = Array.from(latestByLogicalId.values());
  const hasFailed = latest.some((e) => e.resourceStatus.endsWith("_FAILED"));
  if (hasFailed) return "failed";
  const hasInProgress = latest.some((e) => e.resourceStatus.endsWith("_IN_PROGRESS"));
  if (hasInProgress) return "in-progress";
  return "complete";
}

/**
 * 5 phase 派生のコア関数。`stackProgress` は未取得 (= null) を許容する:
 * その場合 `Building` / `CloudFormation Deploy` は status だけから推定する。
 */
export function derivePhases(
  deployment: DeploymentSummary,
  stackProgress: StackProgress | null,
): readonly DeployPhase[] {
  const status = deployment.status;
  const events = stackProgress?.events ?? [];
  const hasObservedCfn = events.length > 0 || (stackProgress?.resources.length ?? 0) > 0;

  // Phase 1: Enqueued — deployment row が存在する時点で常に Complete。
  const enqueued: DeployPhase = {
    id: "enqueued",
    name: "Enqueued",
    status: "complete",
  };

  // Phase 2: Building — CodeBuild step。
  // - CFn 進行が観測されている (= events / resources がある) → Build は Complete
  // - status=FAILED かつ CFn 進行が観測されていない → Build で Failed (= CodeBuild 失敗)
  // - status=IN_PROGRESS かつ CFn 未観測 → In Progress
  // - status=PENDING → Pending
  // - status=COMPLETE / DELETING / DELETED / EXPIRED / AUTO_DELETED → Complete (terminal)
  let buildingStatus: PhaseStatus;
  if (hasObservedCfn) {
    buildingStatus = "complete";
  } else if (status === "PENDING") {
    buildingStatus = "pending";
  } else if (status === "IN_PROGRESS") {
    buildingStatus = "in-progress";
  } else if (status === "FAILED") {
    buildingStatus = "failed";
  } else {
    // terminal statuses — CFn が観測できなくても build は通っていた。
    buildingStatus = "complete";
  }
  const building: DeployPhase = {
    id: "building",
    name: "Building",
    status: buildingStatus,
  };

  // Phase 3: CloudFormation Deploy — stack events を見る。
  // CFn 未割当 (= events 空 + status=PENDING/IN_PROGRESS) は Pending。
  // status=FAILED かつ events 空 → 上の Building で Failed を消化したので CFn 側は Pending のまま。
  let cfnStatus: PhaseStatus;
  // Issue #818: 優先順位 (1) stackStatus が権威 (2) event history (= LogicalId 別最新)
  // (3) status + 観測有無の組み合わせ
  const fromStackStatus = stackStatusToPhaseStatus(stackProgress?.stackStatus);
  if (fromStackStatus !== undefined) {
    cfnStatus = fromStackStatus;
  } else if (events.length === 0) {
    if (status === "COMPLETE") cfnStatus = "complete";
    else if (status === "FAILED") cfnStatus = "pending";
    else if (
      status === "DELETING" ||
      status === "DELETED" ||
      status === "EXPIRED" ||
      status === "AUTO_DELETED"
    )
      cfnStatus = "skipped";
    else cfnStatus = "pending";
  } else {
    cfnStatus = eventsToPhaseStatus(events);
  }
  const cfnDeploy: DeployPhase = {
    id: "cfn-deploy",
    name: "CloudFormation Deploy",
    status: cfnStatus,
  };

  // Phase 4: Health Check — 将来枠。常に Skipped。
  const healthCheck: DeployPhase = {
    id: "health-check",
    name: "Health Check",
    status: "skipped",
    note: "Skipped — will be wired to HealthCheck Lambda in a future iteration",
  };

  // Phase 5: Complete / Teardown — deployment.status を素直に。
  let finalStatus: PhaseStatus;
  if (status === "COMPLETE") finalStatus = "complete";
  else if (status === "FAILED") finalStatus = "failed";
  else if (status === "DELETING") finalStatus = "in-progress";
  else if (status === "DELETED") finalStatus = "skipped";
  else if (status === "EXPIRED") finalStatus = "failed";
  else if (status === "AUTO_DELETED") finalStatus = "skipped";
  else if (COMPLETE_STATUSES.has(status)) finalStatus = "complete";
  else finalStatus = "pending";
  const complete: DeployPhase = {
    id: "complete",
    name: "Complete / Teardown",
    status: finalStatus,
  };

  return [enqueued, building, cfnDeploy, healthCheck, complete];
}

/**
 * deployment + stackProgress から 1 行サマリ ("Deploy succeeded for ..." 等) を作る。
 */
export function deploySummaryTitle(deployment: DeploymentSummary): string {
  const label = deployment.displayTeamName ?? deployment.teamName;
  switch (deployment.status) {
    case "COMPLETE":
      return `Deploy succeeded for ${label}`;
    case "FAILED":
      return `Deploy failed for ${label}`;
    case "IN_PROGRESS":
      return `Deploy in progress for ${label}`;
    case "PENDING":
      return `Deploy queued for ${label}`;
    case "DELETING":
      return `Tearing down ${label}`;
    case "DELETED":
      return `Deploy removed for ${label}`;
    case "EXPIRED":
      return `Deploy expired for ${label}`;
    case "AUTO_DELETED":
      return `Deploy auto-deleted for ${label}`;
    default:
      return `Deploy for ${label}`;
  }
}

/**
 * stack event の timestamp を `HH:MM:SS AM/PM` 形式にする。parse できなければ原文を返す。
 * locale-sensitive な変換は en-US (= Netlify と同じ表記) に固定する。
 */
export function formatLogTimestamp(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export interface LogLine {
  /** Section header (= phase 開始行) かどうか。terminal で色を変える。 */
  readonly header: boolean;
  readonly timestamp?: string;
  readonly text: string;
}

/**
 * 5 phase を 1 本の terminal log に展開する。phase ヘッダ行 + events 行を順に並べる。
 */
export function buildTerminalLog(
  deployment: DeploymentSummary,
  stackProgress: StackProgress | null,
  phases: readonly DeployPhase[],
): readonly LogLine[] {
  const lines: LogLine[] = [];

  for (const phase of phases) {
    lines.push({
      header: true,
      text: `> ${phase.name} [${phase.status}]`,
    });

    switch (phase.id) {
      case "enqueued":
        lines.push({
          header: false,
          timestamp: formatLogTimestamp(deployment.createdAt),
          text: `Enqueued deployment ${deployment.jobId}`,
        });
        lines.push({
          header: false,
          timestamp: formatLogTimestamp(deployment.createdAt),
          text: `tenantId=${deployment.tenantId} problemId=${deployment.problemId} teamName=${deployment.teamName}`,
        });
        break;
      case "building":
        if (stackProgress?.consoleUrl) {
          lines.push({
            header: false,
            text: `CodeBuild console: ${stackProgress.consoleUrl}`,
          });
        } else {
          lines.push({
            header: false,
            text: "CodeBuild console URL not yet available",
          });
        }
        break;
      case "cfn-deploy": {
        const events = stackProgress?.events ?? [];
        if (events.length === 0) {
          lines.push({
            header: false,
            text: "No CloudFormation events observed yet.",
          });
        } else {
          for (const e of events) {
            const reason = e.resourceStatusReason ? ` — ${e.resourceStatusReason}` : "";
            lines.push({
              header: false,
              timestamp: formatLogTimestamp(e.timestamp),
              text: `${e.resourceStatus} ${e.logicalResourceId} (${e.resourceType})${reason}`,
            });
          }
        }
        break;
      }
      case "health-check":
        lines.push({
          header: false,
          text: phase.note ?? "Skipped",
        });
        break;
      case "complete":
        lines.push({
          header: false,
          timestamp: formatLogTimestamp(deployment.updatedAt),
          text: `Deployment status: ${deployment.status}`,
        });
        if (deployment.failureReason) {
          lines.push({
            header: false,
            text: `Failure reason: ${deployment.failureReason}`,
          });
        }
        break;
    }
  }

  return lines;
}
