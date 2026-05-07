import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { buildTeamView, type ParticipantTeamView } from "./lookup.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

export type UpdateOutcome =
  | { kind: "ok"; view: ParticipantTeamView }
  | { kind: "invalid_team_name" }
  | { kind: "unauthorized" };

/**
 * 競技者向け teamName の入力値検証。許可文字: 英数字 / 半角スペース / `_` / `-` /
 * ひらがな / カタカナ / 漢字。1〜40 文字。
 *
 * 制御文字 / 改行 / emoji を弾くのは、Cloudscape の表示崩れと SQL injection 風の
 * 攻撃面を予防するため。
 */
export function validateTeamName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!TEAM_NAME_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 競技者の `displayTeamName` を **team の全 deployment 行で** 更新する。
 *
 * 1 teamLoginKey = 1 team = N deployment なので、display 名は team scope の
 * メタデータとして全行に伝播させる。
 *
 * 編集不可な行 (DELETING / DELETED) は skip し、editable な 1 行も無ければ
 * `unauthorized` を返す (= teamLoginKey 自体が無効化された場合と同じ扱い)。
 *
 * Update は `ReturnValues=ALL_NEW` で更新後 row を取り、その集合から team view を
 * 直接構築する (= 再 query 不要、strong write の整合性を保つ)。
 */
export async function setDisplayTeamName(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  rawName: unknown,
): Promise<UpdateOutcome> {
  const name = validateTeamName(rawName);
  if (!name) return { kind: "invalid_team_name" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const editable = items.filter((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status) && typeof i.PK === "string";
  });
  if (editable.length === 0) return { kind: "unauthorized" };

  const now = new Date().toISOString();
  const updateResults = await Promise.all(
    editable.map((item) =>
      shared.ddb.send(
        new UpdateCommand({
          TableName: shared.tableName,
          Key: { PK: item.PK as string, SK: "META" },
          UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
          ExpressionAttributeValues: { ":name": name, ":now": now },
          ReturnValues: "ALL_NEW",
        }),
      ),
    ),
  );
  const updatedItems = updateResults
    .map((r) => r.Attributes as Partial<DeploymentItem> | undefined)
    .filter((a): a is Partial<DeploymentItem> => !!a);
  const view = buildTeamView(updatedItems, shared.problemsScoring);
  if (!view) return { kind: "unauthorized" };
  return { kind: "ok", view };
}
