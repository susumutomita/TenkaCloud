/**
 * DeploymentDetail を Netlify 風の 4 phase に変換するロジック。
 *
 * 既存の backend を変えずに、`DeploymentSummary` + `StackProgress` だけから派生する。
 * Phase の status は次の順で決まる:
 *   1. Enqueued — deployment row が存在すれば必ず Complete (= 観測時点で row はある)
 *   2. Building — deploy executor step。stack events / resources が 1 件でも観測されたら
 *      Complete、まだなら IN_PROGRESS は In Progress、FAILED + 観測なし は Failed。
 *   3. CloudFormation Deploy — events を見て判定。すべて `_COMPLETE` なら Complete、
 *      `_FAILED` を含めば Failed、`_IN_PROGRESS` を含めば In Progress、空なら Pending。
 *   4. Complete / Teardown — deployment.status を素直に反映。
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

export type PhaseId = "enqueued" | "building" | "cfn-deploy" | "complete";

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
  // 唯一の caller (deriveCfnDeployStatus) が events.length===0 を先に弾くため、ここは
  // 到達不能な防御 guard。 branch coverage のノイズになるので ignore。
  /* v8 ignore next */
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
 * Phase 2: Building の status を判定する。
 * - CFn 進行が観測されていれば必ず complete (= executor は成功して CFn に渡した)
 * - 観測されていない場合は status のみから推定 (= PENDING / IN_PROGRESS / FAILED / terminal)
 */
export function deriveBuildingStatus(
  status: DeploymentStatus,
  hasObservedCfn: boolean,
): PhaseStatus {
  if (hasObservedCfn) return "complete";
  if (status === "PENDING") return "pending";
  if (status === "IN_PROGRESS") return "in-progress";
  if (status === "FAILED") return "failed";
  // terminal statuses (= COMPLETE / DELETING / DELETED / EXPIRED / AUTO_DELETED) は build 通過済。
  return "complete";
}

const CFN_SKIPPED_TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "DELETING",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

/**
 * CFn 未割当 (= events 空) 時の cfn-deploy phase status を status だけから推定する。
 */
function deriveCfnStatusWithoutEvents(status: DeploymentStatus): PhaseStatus {
  if (status === "COMPLETE") return "complete";
  if (status === "FAILED") return "pending";
  if (CFN_SKIPPED_TERMINAL_STATUSES.has(status)) return "skipped";
  return "pending";
}

/**
 * Phase 3: CloudFormation Deploy の status を判定する。
 * Issue #818: 優先順位 (1) stackStatus が権威 (2) event history (= LogicalId 別最新)
 * (3) status + 観測有無の組み合わせ。
 */
export function deriveCfnDeployStatus(
  status: DeploymentStatus,
  stackProgress: StackProgress | null,
): PhaseStatus {
  const fromStackStatus = stackStatusToPhaseStatus(stackProgress?.stackStatus);
  if (fromStackStatus !== undefined) return fromStackStatus;
  const events = stackProgress?.events ?? [];
  if (events.length === 0) return deriveCfnStatusWithoutEvents(status);
  return eventsToPhaseStatus(events);
}

const FINAL_STATUS_FROM_DEPLOYMENT: Partial<Record<DeploymentStatus, PhaseStatus>> = {
  COMPLETE: "complete",
  FAILED: "failed",
  DELETING: "in-progress",
  DELETED: "skipped",
  EXPIRED: "failed",
  AUTO_DELETED: "skipped",
};

/**
 * Phase 5: Complete / Teardown の status を deployment.status から判定する。
 */
export function deriveFinalStatus(status: DeploymentStatus): PhaseStatus {
  const direct = FINAL_STATUS_FROM_DEPLOYMENT[status];
  if (direct !== undefined) return direct;
  // COMPLETE_STATUSES のメンバーは全て FINAL_STATUS_FROM_DEPLOYMENT のキーでもあるため、
  // map miss 時に has() が true になることはない (= 到達不能な防御 fallback)。
  /* v8 ignore next */
  if (COMPLETE_STATUSES.has(status)) return "complete";
  return "pending";
}

/**
 * 4 phase 派生のコア関数。`stackProgress` は未取得 (= null) を許容する:
 * その場合 `Building` / `CloudFormation Deploy` は status だけから推定する。
 *
 * 旧 5 phase に居た Health Check は generic scoring metadata で GenericScoringLambda に
 * 置き換わり (= deploy-time の health check 連携枠としては復活しない設計) のため、
 * 永続 Skipped な dead UI を消した。
 */
export function derivePhases(
  deployment: DeploymentSummary,
  stackProgress: StackProgress | null,
): readonly DeployPhase[] {
  const status = deployment.status;
  const events = stackProgress?.events ?? [];
  const hasObservedCfn = events.length > 0 || (stackProgress?.resources.length ?? 0) > 0;

  return [
    { id: "enqueued", name: "Enqueued", status: "complete" },
    { id: "building", name: "Building", status: deriveBuildingStatus(status, hasObservedCfn) },
    {
      id: "cfn-deploy",
      name: "CloudFormation Deploy",
      status: deriveCfnDeployStatus(status, stackProgress),
    },
    { id: "complete", name: "Complete / Teardown", status: deriveFinalStatus(status) },
  ];
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

function enqueuedPhaseLines(deployment: DeploymentSummary): LogLine[] {
  const ts = formatLogTimestamp(deployment.createdAt);
  return [
    { header: false, timestamp: ts, text: `Enqueued deployment ${deployment.jobId}` },
    {
      header: false,
      timestamp: ts,
      text: `tenantId=${deployment.tenantId} problemId=${deployment.problemId} teamName=${deployment.teamName}`,
    },
  ];
}

function buildingPhaseLines(stackProgress: StackProgress | null): LogLine[] {
  return [
    // `consoleUrl` is a CloudFormation console deep link (backend `buildCfnConsoleUrl`), not a
    // CodeBuild one — the label mislabeled it "CodeBuild" on every deploy (CodeBuild + Lambda
    // paths alike). #2291: name it for what it links to.
    stackProgress?.consoleUrl
      ? { header: false, text: `CloudFormation console: ${stackProgress.consoleUrl}` }
      : { header: false, text: "CloudFormation console URL not yet available" },
  ];
}

function cfnDeployPhaseLines(stackProgress: StackProgress | null): LogLine[] {
  const events = stackProgress?.events ?? [];
  if (events.length === 0) {
    return [{ header: false, text: "No CloudFormation events observed yet." }];
  }
  return events.map((e) => {
    const reason = e.resourceStatusReason ? ` — ${e.resourceStatusReason}` : "";
    return {
      header: false,
      timestamp: formatLogTimestamp(e.timestamp),
      text: `${e.resourceStatus} ${e.logicalResourceId} (${e.resourceType})${reason}`,
    };
  });
}

function completePhaseLines(deployment: DeploymentSummary): LogLine[] {
  const lines: LogLine[] = [
    {
      header: false,
      timestamp: formatLogTimestamp(deployment.updatedAt),
      text: `Deployment status: ${deployment.status}`,
    },
  ];
  if (deployment.failureReason) {
    lines.push({ header: false, text: `Failure reason: ${deployment.failureReason}` });
  }
  return lines;
}

function phaseBodyLines(
  phase: DeployPhase,
  deployment: DeploymentSummary,
  stackProgress: StackProgress | null,
): LogLine[] {
  switch (phase.id) {
    case "enqueued":
      return enqueuedPhaseLines(deployment);
    case "building":
      return buildingPhaseLines(stackProgress);
    case "cfn-deploy":
      return cfnDeployPhaseLines(stackProgress);
    case "complete":
      return completePhaseLines(deployment);
  }
}

/**
 * 4 phase を 1 本の terminal log に展開する。phase ヘッダ行 + events 行を順に並べる。
 */
export function buildTerminalLog(
  deployment: DeploymentSummary,
  stackProgress: StackProgress | null,
  phases: readonly DeployPhase[],
): readonly LogLine[] {
  const lines: LogLine[] = [];
  for (const phase of phases) {
    lines.push({ header: true, text: `> ${phase.name} [${phase.status}]` });
    lines.push(...phaseBodyLines(phase, deployment, stackProgress));
  }
  return lines;
}
