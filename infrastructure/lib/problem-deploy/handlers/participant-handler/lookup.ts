import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploySharedResources } from "../deploy-handler/deploy.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";

/**
 * Participant UI に返す per-team 情報。internal な操作系 (tenantId / awsAccountId /
 * namePrefix / failureReason / 等) は意図的に除外する — チームには「何が動いているか」
 * を見せるが、運営側の構造は隠す。
 */
export interface ParticipantView {
  readonly jobId: string;
  readonly problemId: string;
  readonly teamName: string;
  readonly region: string;
  readonly status: DeploymentStatus;
  /** 問題スタック Outputs を `OutputKey -> OutputValue` の object として展開 */
  readonly stackOutputs: Record<string, string>;
  /** 失敗時 (status=FAILED) のみ。CFn StackStatusReason を string でそのまま返す */
  readonly failureReason?: string;
  /** epoch seconds — TTL 切れ予定時刻。frontend がカウントダウン表示できるように。 */
  readonly expiresAt: number;
}

/**
 * teamLoginKey で GSI2 を Query して 1 件の deployment を返す。
 *
 * - 該当行が無い (key 不正 / 削除済 / GSI2PK 属性が removed) → undefined (401 相当)
 * - 該当行があっても status が DELETING / DELETED → undefined (認証失敗扱い)
 *   GSI2 sparse 化でも「将来 DELETED 行を残す」拡張 (audit log 等) に備える防御
 */
export async function lookupByTeamLoginKey(
  shared: DeploySharedResources,
  teamLoginKey: string,
): Promise<ParticipantView | undefined> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      Limit: 1,
    }),
  );
  const items = (out.Items ?? []) as Partial<DeploymentItem>[];
  const item = items[0];
  if (!item) return undefined;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (status === "DELETING" || status === "DELETED") return undefined;

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    teamName: String(item.teamName ?? ""),
    region: String(item.region ?? ""),
    status,
    stackOutputs: parseStackOutputs(item.stackOutputs),
    failureReason: status === "FAILED" ? item.failureReason : undefined,
    expiresAt: Number(item.expiresAt ?? 0),
  };
}
