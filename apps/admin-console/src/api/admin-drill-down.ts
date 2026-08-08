import type { AppConfig } from "../config";

/**
 * Control Plane (SystemAdmin) 用の AdminInsight API client。
 *
 * **Plane 境界**: 本 client は Control Plane のオペレーション state (= tenant provisioning
 * pipeline / SBT BashJobRunner state machine の execution 履歴) のみを扱う。 tenant 内部の
 * App Plane data (= events / deployments / teams / scoring) を **取得しない** 方針 (2026-05-18
 * user feedback、 「Control Plane が tenant の中身を覗くと plane 境界が壊れる」)。
 *
 * 旧来は `/admin/insight/tenants/:tenantId/events`、 `/deployments/:jobId` 等の App Plane data
 * 経路も同居していたが、 Plane 分離 ([[feedback-no-cross-plane-data-leak]]) で除去した。
 * 必要なら tenant admin が application-admin-console (= App Plane UI) で見る。
 *
 * 全 endpoint で:
 *   - `config.adminInsightApiUrl` が空文字なら **null を返す** (= 未配線、 UI は読み込み中扱い)
 *   - 403 (SystemAdmin claim 無し) / 5xx / network error は `AdminInsightApiError` で throw
 */

export class AdminInsightApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`AdminInsight API ${status}: ${message}`);
    this.name = "AdminInsightApiError";
  }
}

function buildBaseUrl(config: AppConfig): string | null {
  if (!config.adminInsightApiUrl) return null;
  return config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;
}

async function adminInsightGet<T>(
  config: AppConfig,
  idToken: string,
  pathWithQuery: string,
): Promise<T | null> {
  const base = buildBaseUrl(config);
  if (!base) return null;
  const url = new URL(pathWithQuery.replace(/^\//, ""), base);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AdminInsightApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

/**
 * Issue #658: Provisioning Jobs page 用の execution item。
 * `GET /admin/insight/pipeline-executions` の response item shape。
 */
export interface PipelineExecutionItem {
  readonly executionId: string;
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly lastUpdateTimeIso: string | undefined;
  readonly consoleUrl: string;
}

export interface ListPipelineExecutionsResponse {
  readonly pipelineName: string;
  readonly items: readonly PipelineExecutionItem[];
}

/**
 * `GET /admin/insight/pipeline-executions` を叩いて tenkacloud-saas-pipeline の execution
 * 履歴を取得する。 admin-console の Provisioning Jobs page (= /jobs) で使う。
 */
export async function fetchPipelineExecutions(
  config: AppConfig,
  idToken: string,
  options: { limit?: number } = {},
): Promise<ListPipelineExecutionsResponse | null> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `admin/insight/pipeline-executions${qs ? `?${qs}` : ""}`;
  return adminInsightGet<ListPipelineExecutionsResponse>(config, idToken, path);
}

/**
 * Issue #814 Phase 2: SBT BashJobRunner deprovisioning state machine の execution 履歴 item。
 * `GET /admin/insight/state-machine-executions` の response item shape。
 */
export interface StateMachineExecutionItem {
  readonly executionArn: string;
  readonly name: string;
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly stopTimeIso: string | undefined;
  readonly consoleUrl: string;
}

export interface ListStateMachineExecutionsResponse {
  readonly kind: "ok";
  readonly stateMachineArn: string;
  readonly items: readonly StateMachineExecutionItem[];
}

/**
 * Issue #814 Phase 2: `GET /admin/insight/state-machine-executions` を叩いて SBT BashJobRunner
 * の deprovisioning Step Functions の execution 履歴を取得する。 503 (= not_configured、 旧 stack
 * 互換) は `null` を返し、 caller (Jobs page Deprovisioning tab) が legacy placeholder に
 * フォールバックする。
 */
export async function fetchStateMachineExecutions(
  config: AppConfig,
  idToken: string,
  options: { limit?: number } = {},
): Promise<ListStateMachineExecutionsResponse | null> {
  return getExecutions(config, idToken, "admin/insight/state-machine-executions", options);
}

/**
 * `ListExecutions` 系 route の共通 GET。 route 名以外は完全に同じなので、 provisioning /
 * deprovisioning で copy-paste しない。
 */
async function getExecutions(
  config: AppConfig,
  idToken: string,
  route: string,
  options: { limit?: number },
): Promise<ListStateMachineExecutionsResponse | null> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  return adminInsightGet<ListStateMachineExecutionsResponse>(
    config,
    idToken,
    `${route}${qs ? `?${qs}` : ""}`,
  );
}

/**
 * `GET /admin/insight/provisioning-executions` を叩いて SBT ProvisioningScriptJob の Step Functions
 * execution 履歴を取得する。
 *
 * テナントのプロビジョニングが実際に走るのはこの state machine で、 Provisioning Jobs 画面が長らく
 * 見ていた CodePipeline (`tenkacloud-saas-pipeline`) とは別経路。 そのため 3 テナントを同時に
 * provisioning しても画面には 1 件も出ず、 代わりに無関係な pipeline の失敗だけが「プロビジョニング
 * 失敗」として表示されていた (2026-08-08 に運用者が誤認)。
 *
 * 503 (= not_configured、 旧 stack 互換) は `null`。
 */
export async function fetchProvisioningExecutions(
  config: AppConfig,
  idToken: string,
  options: { limit?: number } = {},
): Promise<ListStateMachineExecutionsResponse | null> {
  return getExecutions(config, idToken, "admin/insight/provisioning-executions", options);
}
