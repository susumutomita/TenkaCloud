import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  CHALLENGE_PREREQUISITE_GATE_FLAG,
  type ProgressionGateConfig,
} from "../shared/progression-gate.js";
import { getFeatureFlags } from "./feature-flags.js";
import type { EventSharedResources } from "./shared.js";
import type { EventItem, TeamItem } from "./types.js";

/**
 * Issue #2283: Progression Gate 設定の service 層。
 *
 * schema 内で閉じる検証 (自己参照 / 重複 target / 値域) は
 * `ProgressionGateConfigSchema` (= route 入口の parse) が担い、 本 module は
 * cross-entity 検証を担う:
 *   - Gate challenge / unlock target が **その Event に含まれる問題** であること
 *   - team override の teamId が **その Event の実在 team** であること
 *   - per-tenant feature flag `challengePrerequisiteGate` が ON であること
 *     (= Flag OFF の環境では運営者が誤って Gate を設定できない、 Issue #2283 完了条件)
 *
 * 除去 (`removeProgressionGate`) は flag OFF でも許可する — 設定の削除は競技を
 * 制約しない方向の操作であり、 flag を OFF に切替えた後に古い設定を掃除できる必要がある。
 */

/** `invalid` outcome の機械判定用 reason。 route はそのまま body に載せ、 UI が文言化する。 */
export type ProgressionGateInvalidReason =
  | "gate_problem_not_in_event"
  | "unlock_target_not_in_event"
  | "unknown_override_team"
  | "event_archived";

export type SetProgressionGateOutcome =
  | { kind: "not_found" }
  | { kind: "feature_disabled" }
  | { kind: "invalid"; reason: ProgressionGateInvalidReason }
  | { kind: "ok"; progressionGate: ProgressionGateConfig };

export type RemoveProgressionGateOutcome = { kind: "not_found" } | { kind: "ok"; removed: boolean };

export async function setProgressionGate(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  config: ProgressionGateConfig,
  nowMs: number,
): Promise<SetProgressionGateOutcome> {
  // 3 read (tenant flag / event META / teams) は独立なので並列発火。
  const [flags, eventOut, teamsOut] = await Promise.all([
    getFeatureFlags(shared, tenantId),
    shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
      }),
    ),
    shared.ddb.send(
      new QueryCommand({
        TableName: shared.teamsTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":tprefix": "TEAM#" },
        ProjectionExpression: "teamId",
      }),
    ),
  ]);

  // Flag OFF の tenant では設定自体を受け付けない (誤設定 → 有効化事故の予防)。
  if (flags[CHALLENGE_PREREQUISITE_GATE_FLAG] !== true) return { kind: "feature_disabled" };

  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return { kind: "not_found" };
  if (event.status === "ARCHIVED") return { kind: "invalid", reason: "event_archived" };

  const invalid = validateAgainstEvent(
    config,
    event,
    (teamsOut.Items ?? []) as Partial<TeamItem>[],
  );
  if (invalid) return { kind: "invalid", reason: invalid };

  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET progressionGate = :cfg, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":cfg": config,
          ":now": new Date(nowMs).toISOString(),
          ":tenantId": tenantId,
        },
      }),
    );
  } catch (err) {
    // read と write の間に event が消えた / tenant が変わった race は 404 に倒す
    // (removeProgressionGate と同じ扱い。 存在を漏らさず 500 も出さない)。
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return { kind: "not_found" };
    }
    throw err;
  }
  return { kind: "ok", progressionGate: config };
}

/**
 * Gate 設定を除去する。 idempotent: 既に未設定でも `ok` (removed=false) を返す。
 * lock 状態は永続していない (= read 時導出) ので、 除去は次の read から即 unlock を意味する。
 */
export async function removeProgressionGate(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<RemoveProgressionGateOutcome> {
  try {
    const out = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "REMOVE progressionGate SET updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":now": new Date(nowMs).toISOString(),
          ":tenantId": tenantId,
        },
        ReturnValues: "ALL_OLD",
      }),
    );
    const before = out.Attributes as Partial<EventItem> | undefined;
    return { kind: "ok", removed: before?.progressionGate !== undefined };
  } catch (err) {
    // tenant 不一致 / 行不在はどちらも ConditionalCheckFailed → 404 (存在を漏らさない)。
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return { kind: "not_found" };
    }
    throw err;
  }
}

function validateAgainstEvent(
  config: ProgressionGateConfig,
  event: Partial<EventItem>,
  teams: readonly Partial<TeamItem>[],
): ProgressionGateInvalidReason | undefined {
  const problemIds = new Set(
    (Array.isArray(event.problems) ? event.problems : []).map((p) => p.problemId),
  );
  if (!problemIds.has(config.gateProblemId)) return "gate_problem_not_in_event";
  if (config.unlockTargetIds.some((id) => !problemIds.has(id))) {
    return "unlock_target_not_in_event";
  }
  const teamIds = new Set(
    teams.map((t) => t.teamId).filter((id): id is string => typeof id === "string"),
  );
  const overrideTeamIds = Object.keys(config.teamOverrides ?? {});
  if (overrideTeamIds.some((id) => !teamIds.has(id))) return "unknown_override_team";
  return undefined;
}
