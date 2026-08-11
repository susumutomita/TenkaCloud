import type { ApiClient } from "./client";

export const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * DDB の `stackOutputs` 文字列を `{key: value}` map に変換。次の 2 形式を許容する:
 *   1. `{key: value}` (Lambda 由来)
 *   2. `[{OutputKey, OutputValue}, ...]` (Step Functions describeStacks 由来)
 *
 * Backend (`infrastructure/lib/problem-deploy/handlers/shared/cfn-status.ts`) に同じ
 * 関数の sister 実装あり。両者は意味的に同一にする (frontend / backend の DTO 共有)。
 *
 * 壊れた JSON / 非 string value は無視 (best-effort 表示、ページを落とさない)。
 */
export function parseStackOutputs(json: string | undefined): Record<string, string> {
  if (!json) return {};
  const parsed = parseJson(json);
  if (!isObjectLike(parsed)) return {};
  return Array.isArray(parsed)
    ? stackOutputArrayToRecord(parsed)
    : stackOutputMapToRecord(parsed as Record<string, unknown>);
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function stackOutputArrayToRecord(entries: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (!isObjectLike(entry)) continue;
    const k = (entry as { OutputKey?: unknown }).OutputKey;
    const v = (entry as { OutputValue?: unknown }).OutputValue;
    if (typeof k === "string" && typeof v === "string") out[k] = v;
  }
  return out;
}

function stackOutputMapToRecord(entries: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export type DeploymentStatus =
  | "PENDING"
  // Issue #2019: TrustBridge が operator approval を待つ間の状態。stack 未作成の
  // in-flight 状態であり、terminal ではない。
  | "APPROVAL_PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "EXPIRED"
  | "AUTO_DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

export const DEPLOYMENT_STATUS_INDICATOR: Record<
  DeploymentStatus,
  "pending" | "in-progress" | "success" | "error" | "stopped" | "warning"
> = {
  PENDING: "pending",
  // Issue #2019: held for approval — show as pending (in-flight, no stack yet).
  APPROVAL_PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
  EXPIRED: "warning",
  AUTO_DELETED: "stopped",
};

export interface DeployRequestBody {
  readonly region: string;
  readonly awsAccountId: string;
  readonly teamName: string;
}

export interface DeployResponse {
  readonly jobId: string;
  readonly status: DeploymentStatus;
  readonly namePrefix: string;
  /** チーム共有ログインキー。レスポンスで 1 度だけ露出するので、UI 側で表示し別途控える。 */
  readonly teamLoginKey: string;
  readonly expiresAt: number;
}

/**
 * Composite (multi-cloud) targets a competitor account can run on. Mirrors the
 * backend whitelist in
 * `infrastructure/lib/problem-deploy/handlers/deploy-handler/composite-detail.ts`.
 */
export type CompositeTargetProvider = "aws" | "gcp" | "azure" | "sakura";

/**
 * [Composite Runtime / Issue #2747] Where a target sits in its parent's dependency graph, mirrors
 * `CompositeDependencyState` in `composite-detail.ts`. Absent (`dependencyState` undefined) on a
 * target row that predates #2747 (no dependency/binding metadata was ever persisted for it).
 */
export type CompositeDependencyState = "ready" | "waiting" | "running" | "complete" | "blocked";

/**
 * One composite child target, as projected by the backend `buildCompositeDetail`
 * (#2073). Display-only: the backend strips every credential / role / login-key
 * field, so a target row is never an auth input on the frontend.
 */
export interface CompositeTargetSummary {
  readonly targetId: string;
  readonly targetDeploymentId: string;
  readonly ordinal: number;
  readonly provider: CompositeTargetProvider;
  readonly engine: string;
  readonly status: DeploymentStatus;
  readonly updatedAt: string;
  readonly failureReason?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  /** [#2747] Execution wave (0-based); undefined on a legacy (pre-#2747) target row. */
  readonly executionWave?: number;
  /** [#2747] Undefined on a legacy target row that carries no dependency graph metadata. */
  readonly dependencyState?: CompositeDependencyState;
  /** [#2747] Explicit prerequisite target ids. Undefined on a legacy target row. */
  readonly dependsOn?: readonly string[];
  /** [#2747] Bound input parameter names (values never sent to the frontend). */
  readonly inputParameters?: readonly string[];
}

/**
 * The optional `composite` block a composite-parent deployment-detail response
 * carries. Legacy single-provider deployments never include it (byte compat).
 */
export interface CompositeDetail {
  readonly version: number;
  readonly targets: readonly CompositeTargetSummary[];
}

/**
 * [Problem Packs / Issue #2096] Pack provenance for a PACK-SOURCED deployment,
 * resolved by the backend from the event-pinned catalog snapshot (#2095). The
 * detail (`getDeployment`) response carries it only for pack deployments; core
 * deployments omit it. It carries no local path / source credential.
 */
export interface DeploymentProvenance {
  readonly packId: string;
  readonly packVersion: string;
  readonly contentDigest: string;
  readonly catalogSnapshotId: string;
}

export interface DeploymentSummary {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  /** Operator が deploy form で入力した内部 slug (CFn StackName 由来、immutable)。 */
  readonly teamName: string;
  /** 競技者が portal で設定した表示用チーム名。未設定なら undefined。 */
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  /**
   * Composite (multi-cloud) parent でのみ返る per-target status。legacy
   * single-provider deployment では undefined (= 旧 UI を byte 互換に保つ)。
   */
  readonly composite?: CompositeDetail;
  /**
   * [#2096] Pack provenance. Present on the detail response only for a
   * PACK-SOURCED deployment; absent for core problems (= existing shape).
   */
  readonly provenance?: DeploymentProvenance;
}

export interface ListDeploymentsResponse {
  readonly items: readonly DeploymentSummary[];
  readonly nextCursor?: string;
}

export function startDeployment(
  client: ApiClient,
  problemId: string,
  body: DeployRequestBody,
): Promise<DeployResponse> {
  return client.post<DeployResponse>(`/problems/${encodeURIComponent(problemId)}/deploy`, body);
}

export function getDeployment(client: ApiClient, jobId: string): Promise<DeploymentSummary> {
  return client.get<DeploymentSummary>(`/deployments/${encodeURIComponent(jobId)}`);
}

/**
 * #534: deploy job 詳細ページに CFn 進行状況を出すための DTO。Backend
 * (`infrastructure/lib/problem-deploy/handlers/deploy-handler/stack-progress.ts`) の
 * `StackProgress` と意味的に同一。新規 field を追加するときは両側で同期する。
 */
export interface StackProgressEvent {
  readonly timestamp: string;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
}

export interface StackProgressResource {
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
  readonly physicalResourceId?: string;
}

export interface StackProgress {
  readonly jobId: string;
  readonly stackName: string;
  readonly region: string;
  readonly consoleUrl: string;
  readonly events: readonly StackProgressEvent[];
  readonly resources: readonly StackProgressResource[];
  readonly stackStatus?: string;
  readonly stuck?: StackStuckDiagnosis;
}

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

export function getStackProgress(client: ApiClient, jobId: string): Promise<StackProgress> {
  return client.get<StackProgress>(`/deployments/${encodeURIComponent(jobId)}/stack-progress`);
}

/**
 * CFn ResourceStatus を Cloudscape の `StatusIndicator` type にマップする。
 * 未知 status は "in-progress" にフォールバック (= 新しい CFn status が来ても落ちない)。
 *
 * 評価順は **specific → general**: `DELETE_COMPLETE` を先に判定しないと
 * 「`_COMPLETE` で終わる」rule が拾ってしまう。
 */
export function statusToIndicator(
  status: string,
): "success" | "error" | "in-progress" | "warning" | "stopped" {
  if (status === "DELETE_COMPLETE") return "stopped";
  if (status.endsWith("_FAILED")) return "error";
  if (status.includes("ROLLBACK")) return "warning";
  if (status.endsWith("_COMPLETE")) return "success";
  return "in-progress";
}

export function deleteDeployment(client: ApiClient, jobId: string): Promise<void> {
  return client.del(`/deployments/${encodeURIComponent(jobId)}`);
}

export interface ListDeploymentsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export function listDeployments(
  client: ApiClient,
  problemId: string,
  params: ListDeploymentsParams = {},
): Promise<ListDeploymentsResponse> {
  return fetchDeployments(client, `/problems/${encodeURIComponent(problemId)}/deployments`, params);
}

/** Tenant 内の deployment 一覧 (problemId scope なし)。サイドバー「デプロイ履歴」が引く。 */
export function listAllDeployments(
  client: ApiClient,
  params: ListDeploymentsParams = {},
): Promise<ListDeploymentsResponse> {
  return fetchDeployments(client, "/deployments", params);
}

function fetchDeployments(
  client: ApiClient,
  basePath: string,
  params: ListDeploymentsParams,
): Promise<ListDeploymentsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return client.get<ListDeploymentsResponse>(`${basePath}${suffix}`);
}
