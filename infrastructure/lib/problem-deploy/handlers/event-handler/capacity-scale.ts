import { SSMClient, StartAutomationExecutionCommand } from "@aws-sdk/client-ssm";
import { z } from "zod";
import { EVENT_CAPACITY_CEILING } from "../../event-capacity-constants.js";
import {
  type CapacityTableRole,
  CapacityUnconfiguredError,
  resolveEventHotTables,
} from "./capacity.js";
import type { EventSharedResources } from "./shared.js";

/**
 * Issue #2680: `POST /admin/capacity` — Slice 1 の SSM runbook (event-capacity-runbook.ts) を
 * admin console から起動する write 側 service。read 側の overview 集計は `capacity.ts`。
 *
 * CLI 実行 (docs/operations/dynamodb-event-capacity.md) と完全に同じ document を叩くので、
 * ガード 3 層 (allowedPattern ceiling / allowedValues / automation role IAM) と実行履歴
 * (StartAutomationExecution) はそのまま効く。本 module はその手前に API 側の再検証
 * ({@link CapacityScaleBodySchema} の ceiling / {@link resolveEventHotTables} の allowlist) を
 * defense in depth として重ねる。
 */

/**
 * `POST /admin/capacity` の body。runbook parameter の `allowedPattern`
 * (1..{@link EVENT_CAPACITY_CEILING}) をすり抜ける経路への defense in depth として、
 * API 側でも同じ ceiling を再検証する (SSM 実行前に fail する = 実行履歴を汚さない)。
 */
export const CapacityScaleBodySchema = z.object({
  tableName: z.string().min(1),
  readCapacityUnits: z.coerce.number().int().min(1).max(EVENT_CAPACITY_CEILING),
  writeCapacityUnits: z.coerce.number().int().min(1).max(EVENT_CAPACITY_CEILING),
});

/**
 * 純 SQL backend (turso) には event-hot DynamoDB table が 1 つも無く、scale 対象が存在しない。
 * route は 409 `capacity_not_applicable` に変換する (= overview の `applicable:false` と同じ
 * 判定の write 側)。
 */
export class CapacityNotApplicableError extends Error {
  constructor() {
    super("capacity scaling is not applicable: this backend has no event-hot DynamoDB tables");
    this.name = "CapacityNotApplicableError";
  }
}

/**
 * 要求された tableName が event-hot allowlist (= {@link resolveEventHotTables}) に無い。
 * runbook document 側の `allowedValues` + automation role IAM と三重の防御で、API 経由でも
 * 他テーブルへの適用を構造的に不可能にする。route は 400 `invalid_table` に変換する。
 */
export class CapacityTableNotAllowedError extends Error {
  constructor(tableName: string) {
    super(`table ${tableName} is not an event-hot table eligible for capacity scaling`);
    this.name = "CapacityTableNotAllowedError";
  }
}

export interface CapacityScaleClients {
  readonly ssm: Pick<SSMClient, "send">;
}

/** `capacity.ts` の defaultCapacityClients と同じ module-scope cache pattern (tests は fake を注入)。 */
let cachedScaleClients: CapacityScaleClients | undefined;
export function defaultCapacityScaleClients(): CapacityScaleClients {
  if (!cachedScaleClients) {
    cachedScaleClients = { ssm: new SSMClient({}) };
  }
  return cachedScaleClients;
}

export interface CapacityScaleInput {
  readonly tableName: string;
  readonly readCapacityUnits: number;
  readonly writeCapacityUnits: number;
}

export interface CapacityScaleResult {
  readonly executionId: string;
  readonly tableName: string;
  readonly role: CapacityTableRole;
}

/**
 * runbook を StartAutomationExecution で起動する。`AutomationAssumeRole` は渡さない —
 * document の default (= 同 stack の least-privilege AutomationRole) を使う。呼び出し側
 * Lambda には `iam:PassRole` (対象 = その role のみ) が stack 側で付与される
 * (event-api-lambda.ts)。
 */
export async function startCapacityScale(
  shared: Pick<
    EventSharedResources,
    "deploymentsTableName" | "eventsTableName" | "teamsTableName" | "disruptionsTableName"
  >,
  input: CapacityScaleInput,
  clients: CapacityScaleClients = defaultCapacityScaleClients(),
): Promise<CapacityScaleResult> {
  const documentName = process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME || "";
  if (documentName === "") {
    throw new CapacityUnconfiguredError("CAPACITY_RUNBOOK_DOCUMENT_NAME");
  }
  const tables = resolveEventHotTables(shared);
  if (tables.length === 0) {
    throw new CapacityNotApplicableError();
  }
  // API 側の allowlist 再検証 (defense in depth): runbook の allowedValues に必ず一致する
  // 5 テーブル以外は SSM に送る前に拒否する。
  const target = tables.find((t) => t.tableName === input.tableName);
  if (!target) {
    throw new CapacityTableNotAllowedError(input.tableName);
  }
  const out = await clients.ssm.send(
    new StartAutomationExecutionCommand({
      DocumentName: documentName,
      Parameters: {
        TableName: [target.tableName],
        ReadCapacityUnits: [String(input.readCapacityUnits)],
        WriteCapacityUnits: [String(input.writeCapacityUnits)],
      },
    }),
  );
  const executionId = (out as { AutomationExecutionId?: string }).AutomationExecutionId;
  // 実行 id が無い受理は追跡不能 (実行履歴と突合できない) なので fail loudly。
  if (!executionId) {
    throw new Error("StartAutomationExecution returned no AutomationExecutionId");
  }
  return { executionId, tableName: target.tableName, role: target.role };
}
