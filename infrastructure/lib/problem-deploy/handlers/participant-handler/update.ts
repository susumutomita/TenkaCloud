import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { type ParticipantView, toView } from "./lookup.js";
import type { ParticipantSharedResources } from "./shared.js";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

const NON_EDITABLE_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

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
 * 競技者の `displayTeamName` を更新する。
 *
 * GSI2 Query → 自分の行の `PK/status` を確認し、UpdateCommand を `ReturnValues=
 * ALL_NEW` で実行して更新後の行を取得 → そのまま `toView` で返却。
 * 旧実装の「Query → Update → Query (再 lookup)」3 round-trip を 2 round-trip に
 * 圧縮し、Update と再 Query の間の eventual consistency 窓も無くす。
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
  if (NON_EDITABLE_STATUSES.has(status)) return { kind: "unauthorized" };
  if (!item.PK) return { kind: "unauthorized" };

  const updateOut = await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.tableName,
      Key: { PK: item.PK, SK: "META" },
      UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
      ExpressionAttributeValues: {
        ":name": name,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  const updated = updateOut.Attributes as Partial<DeploymentItem> | undefined;
  if (!updated) return { kind: "unauthorized" };
  const view = toView(updated, shared.problemsScoring);
  if (!view) return { kind: "unauthorized" };
  return { kind: "ok", view };
}
