import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { lookupByTeamLoginKey, type ParticipantView } from "./lookup.js";
import type { ParticipantSharedResources } from "./shared.js";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

const NON_TEARDOWNABLE_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

export type UpdateOutcome =
  | { kind: "ok"; view: ParticipantView }
  | { kind: "invalid_team_name" }
  | { kind: "unauthorized" };

/**
 * 競技者向け teamName の入力値検証。許可文字: 英数字 / 半角スペース / `_` / `-` /
 * ひらがな / カタカナ / 漢字。1〜40 文字。
 *
 * 制御文字 / 改行 / emoji を弾くのは、Cloudscape の表示崩れと SQL injection 風の
 * 攻撃面を予防するため (DDB 自体には injection リスクは無いが、後段の UI / CSV
 * export 等で safe であることを保証する)。
 */
export function validateTeamName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!TEAM_NAME_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 競技者の teamName を更新する。
 *
 * 1. teamLoginKey で deployment を引く (lookup と同じ経路)
 * 2. status が DELETING/DELETED なら unauthorized
 * 3. PK/SK を取り直して UpdateItem (`displayTeamName = :name`)
 * 4. 更新後の view を返す
 */
export async function setDisplayTeamName(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  rawName: unknown,
): Promise<UpdateOutcome> {
  const name = validateTeamName(rawName);
  if (!name) return { kind: "invalid_team_name" };

  const queryOut = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      Limit: 1,
    }),
  );
  const item = queryOut.Items?.[0] as Partial<DeploymentItem> | undefined;
  if (!item) return { kind: "unauthorized" };
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (NON_TEARDOWNABLE_STATUSES.has(status)) return { kind: "unauthorized" };
  if (!item.PK) return { kind: "unauthorized" };

  await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.tableName,
      Key: { PK: item.PK, SK: "META" },
      UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
      ExpressionAttributeValues: {
        ":name": name,
        ":now": new Date().toISOString(),
      },
    }),
  );

  // 更新後の view を再取得して返す。
  const view = await lookupByTeamLoginKey(shared, teamLoginKey);
  if (!view) return { kind: "unauthorized" };
  return { kind: "ok", view };
}
