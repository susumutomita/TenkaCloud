import {
  CodePipelineClient,
  ListPipelineExecutionsCommand,
  type PipelineExecutionSummary,
} from "@aws-sdk/client-codepipeline";

/**
 * Issue #658: admin-console の Provisioning Jobs page が叩く `GET /admin/insight/pipeline-executions`
 * の実装。
 *
 * `tenkacloud-saas-pipeline` (= ServerlessSaaSPipeline 由来の CodePipeline) の execution 履歴を
 * `ListPipelineExecutions` で取得し、 frontend が直接 render しやすい shape に整形する。
 *
 * 認可は呼び出し元 (handler index.ts) で SystemAdmin claim を検査済前提。本 module 内では再検査しない。
 *
 * Pipeline 単位の rate limit (= CodePipeline API: 250 RPS / region per account) は admin-console
 * の 60s polling では問題にならない。 1 invoke = 1 API call、 page size は 50 で十分。
 */

const PIPELINE_NAME = "tenkacloud-saas-pipeline";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface PipelineExecutionItem {
  readonly executionId: string;
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly lastUpdateTimeIso: string | undefined;
  /**
   * AWS console deep link (= operator が click で console に飛べる)。
   * 形式: `https://<region>.console.aws.amazon.com/codesuite/codepipeline/pipelines/<pipeline>/executions/<execId>/timeline?region=<region>`
   */
  readonly consoleUrl: string;
}

export interface ListPipelineExecutionsResponse {
  readonly pipelineName: string;
  readonly items: readonly PipelineExecutionItem[];
}

export interface ListPipelineExecutionsDeps {
  readonly client: Pick<CodePipelineClient, "send">;
  readonly region: string;
}

export const defaultPipelineClient = new CodePipelineClient({});

export function buildExecutionConsoleUrl(
  region: string,
  pipelineName: string,
  executionId: string,
): string {
  return `https://${region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${encodeURIComponent(pipelineName)}/executions/${encodeURIComponent(executionId)}/timeline?region=${region}`;
}

export function summarizeExecution(
  region: string,
  pipelineName: string,
  raw: PipelineExecutionSummary,
): PipelineExecutionItem | null {
  const executionId = raw.pipelineExecutionId;
  if (!executionId) return null;
  return {
    executionId,
    status: raw.status ?? "Unknown",
    startTimeIso: raw.startTime ? new Date(raw.startTime).toISOString() : undefined,
    lastUpdateTimeIso: raw.lastUpdateTime ? new Date(raw.lastUpdateTime).toISOString() : undefined,
    consoleUrl: buildExecutionConsoleUrl(region, pipelineName, executionId),
  };
}

export interface ListPipelineExecutionsOptions {
  readonly limit?: number;
}

export async function listPipelineExecutions(
  deps: ListPipelineExecutionsDeps,
  options: ListPipelineExecutionsOptions = {},
): Promise<ListPipelineExecutionsResponse> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const out = await deps.client.send(
    new ListPipelineExecutionsCommand({
      pipelineName: PIPELINE_NAME,
      maxResults: limit,
    }),
  );
  const items = (out.pipelineExecutionSummaries ?? [])
    .map((s) => summarizeExecution(deps.region, PIPELINE_NAME, s))
    .filter((x): x is PipelineExecutionItem => x !== null);
  return { pipelineName: PIPELINE_NAME, items };
}
