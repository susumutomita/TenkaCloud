import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { lookupTeamByLoginKey, type ParticipantTeamView } from "./lookup.js";
import type { ParticipantSharedResources } from "./shared.js";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

const NON_EDITABLE_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

export type UpdateOutcome =
  | { kind: "ok"; view: ParticipantTeamView }
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
 * 競技者の `displayTeamName` を **team の全 deployment 行で** 更新する (Phase 2c)。
 *
 * 1 teamLoginKey = 1 team = N deployment になったため、display 名は team scope の
 * メタデータとして全行に伝播させる。`team` 集約 (Teams table) には book-keeping
 * しないが、Participant Portal が `lookupTeamByLoginKey` で全行から代表値を取って
 * 表示に使うので、すべての行で同じ値になっている必要がある。
 *
 * 編集不可な行 (DELETING / DELETED) は skip し、editable な 1 行も無ければ
 * `unauthorized` を返す (= teamLoginKey 自体が無効化された場合と同じ扱い)。
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
    }),
  );
  const items = (queryOut.Items ?? []) as Partial<DeploymentItem>[];
  if (items.length === 0) return { kind: "unauthorized" };

  const editable = items.filter((i) => {
    const status = (i.status ?? "PENDING") as DeploymentStatus;
    return !NON_EDITABLE_STATUSES.has(status) && typeof i.PK === "string";
  });
  if (editable.length === 0) return { kind: "unauthorized" };

  const now = new Date().toISOString();
  await Promise.all(
    editable.map((item) =>
      shared.ddb.send(
        new UpdateCommand({
          TableName: shared.tableName,
          Key: { PK: item.PK as string, SK: "META" },
          UpdateExpression: "SET displayTeamName = :name, updatedAt = :now",
          ExpressionAttributeValues: { ":name": name, ":now": now },
        }),
      ),
    ),
  );

  // 更新後の team view を構築するために再 lookup。Update の eventually consistent な
  // 反映を避けるため `lookupTeamByLoginKey` 内の Query は GSI2 で eventually
  // consistent だが、`teamName` フィールドは UpdateCommand の strong write が反映済
  // (= 直近の write 後に Query しても eventually 数十 ms 以内に新値が見える)。
  const updated = await lookupTeamByLoginKey(shared, teamLoginKey);
  if (!updated) return { kind: "unauthorized" };
  return { kind: "ok", view: updated };
}
