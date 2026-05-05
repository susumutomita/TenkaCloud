import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { ParticipantSharedResources } from "./shared.js";

/**
 * 競技者向け sanitized view。`DeploymentItem` から chosen フィールドのみを `Pick`
 * で派生させることで、`DeploymentItem` に新規フィールドが増えたときに「明示的に
 * include する / 除外する」判断を強制する (operator 内部情報の意図せぬ漏洩を防ぐ)。
 *
 * stackOutputs は DDB に JSON 文字列で入っているが、UI に返す前に object へ展開する。
 */
export type ParticipantView = Pick<
  DeploymentItem,
  "jobId" | "problemId" | "teamName" | "region" | "expiresAt"
> & {
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
};

const DELETED_LIKE_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

/**
 * teamLoginKey で GSI2 を Query して 1 件の deployment を返す。
 *
 * GSI2 は eventually consistent。直近に rotate / 削除された teamLoginKey は
 * 最大数百ms 程度認証が通る可能性があるが、TTL ベースの teardown を 1 分間隔で
 * 回す運用 (PR-E StatusUpdater) と整合する許容範囲。
 *
 * - 該当行が無い (key 不正 / GSI2PK 属性が削除された) → undefined (401 相当)
 * - status が DELETING / DELETED → undefined (sparse 化が崩れた場合の防御)
 */
export async function lookupByTeamLoginKey(
  shared: ParticipantSharedResources,
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
  const item = (out.Items?.[0] ?? undefined) as Partial<DeploymentItem> | undefined;
  if (!item) return undefined;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return undefined;

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
