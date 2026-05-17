import { type ExecutionListItem, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";

/**
 * Issue #814 Phase 2: admin-console の 「Deprovisioning Jobs」 タブが叩く
 * \`GET /admin/insight/state-machine-executions\` の handler 実装。
 *
 * SBT \`BashJobRunner\` (= \`deprovisioningJobRunner\`) が立てる Step Functions State Machine
 * の \`ListExecutions\` を呼び、 frontend が直接 render しやすい shape に整形する。
 *
 * 認可は呼び出し元 (handler index.ts) で SystemAdmin claim を検査済前提。本 module 内では再検査しない。
 *
 * env \`DEPROVISIONING_STATE_MACHINE_ARN\` 未設定なら \`{ kind: \"not_configured\" }\` を返し、
 * route 側で 503 にマップする (= legacy stack 互換)。
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface StateMachineExecutionItem {
  readonly executionArn: string;
  readonly name: string;
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly stopTimeIso: string | undefined;
  /**
   * AWS console deep link (= operator が click で console に飛べる)。
   * 形式: \`https://<region>.console.aws.amazon.com/states/home?region=<region>#/v2/executions/details/<execArn>\`
   */
  readonly consoleUrl: string;
}

export type ListStateMachineExecutionsResponse =
  | { kind: "ok"; stateMachineArn: string; items: readonly StateMachineExecutionItem[] }
  | { kind: "not_configured" };

export interface ListStateMachineExecutionsDeps {
  readonly client: Pick<SFNClient, "send">;
  readonly region: string;
  readonly stateMachineArn: string | undefined;
}

export const defaultSfnClient = new SFNClient({});

export function buildExecutionConsoleUrl(region: string, executionArn: string): string {
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${encodeURIComponent(executionArn)}`;
}

export function summarizeExecution(
  region: string,
  raw: ExecutionListItem,
): StateMachineExecutionItem | null {
  const arn = raw.executionArn;
  if (!arn) return null;
  return {
    executionArn: arn,
    name: raw.name ?? "(unnamed)",
    status: raw.status ?? "Unknown",
    startTimeIso: raw.startDate ? new Date(raw.startDate).toISOString() : undefined,
    stopTimeIso: raw.stopDate ? new Date(raw.stopDate).toISOString() : undefined,
    consoleUrl: buildExecutionConsoleUrl(region, arn),
  };
}

export interface ListStateMachineExecutionsOptions {
  readonly limit?: number;
}

export async function listStateMachineExecutions(
  deps: ListStateMachineExecutionsDeps,
  options: ListStateMachineExecutionsOptions = {},
): Promise<ListStateMachineExecutionsResponse> {
  if (!deps.stateMachineArn) return { kind: "not_configured" };
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const out = await deps.client.send(
    new ListExecutionsCommand({
      stateMachineArn: deps.stateMachineArn,
      maxResults: limit,
    }),
  );
  const items = (out.executions ?? [])
    .map((e) => summarizeExecution(deps.region, e))
    .filter((x): x is StateMachineExecutionItem => x !== null);
  return { kind: "ok", stateMachineArn: deps.stateMachineArn, items };
}
