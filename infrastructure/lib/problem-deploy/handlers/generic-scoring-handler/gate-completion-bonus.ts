import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  CHALLENGE_PREREQUISITE_GATE_FLAG,
  isGateCompleted,
  type ProgressionGateConfig,
  resolveTeamGatePolicy,
  selectGateCompletionRow,
} from "../shared/progression-gate.js";
import { buildScoreEventItem } from "../shared/score-event.js";
import { isTenantFeatureEnabled } from "../shared/tenant-feature-flags.js";

/**
 * Issue #2283: scoring tick 側の Progression Gate 処理。
 *
 * 1. **完了 latch** (`maybeLatchGateCompletion`): Gate challenge の行が完了 (score > 0 /
 *    flagSubmitted) したら `gateCompletedAt` を one-time で latch する。 完了後に uptime
 *    penalty で score が 0 以下へ戻っても unlock 状態が flap しないための固定化。
 *    bonus の有無 / feature flag と独立に全 team へ書く (= 1 行 1 回の軽い write)。
 *
 * 2. **完了 bonus** (`maybeLatchGateCompletion` 内): team override の `completionBonus` を
 *    1 度だけ加算する。 完了判定は前 tick までに書かれた値で行うので、 初回加点の
 *    **次の tick** で bonus が付く (= 最大 1 分遅延。 event 終了間際の完了は次の active tick
 *    が無く付与されない edge があり、 これは初期実装の既知の制約として文書化する)。
 *    冪等性: `gateBonusAwardedAt` への conditional update。 score ADD と score event 行の
 *    append は **1 TransactWrite** で書き、 「score は加算されたのに履歴行が無い」 分裂を
 *    構造的に防ぐ。
 *
 * 3. **locked 問題の採点 skip** (`isLockedForScoring`): unlock target の deployment は
 *    Gate 未完了の間、 polling 採点 (uptime probe / 加点 / 減点) を skip する。
 *    operator が bulk deploy した locked 問題が 「参加者が触れないのに勝手に加点 / 減点
 *    される」 のを防ぐ。 team の Gate 行は対象行の GSI2 (teamLoginKey) を invocation 内
 *    cache 付きで 1 Query して引く。
 *
 * per-tenant flag `challengePrerequisiteGate` (既定 OFF) が OFF の間は bonus / skip とも
 * 無効 (latch は flag と独立 — 完了事実の記録であって enforcement ではない)。
 */

interface GateScoringShared {
  readonly ddb: DynamoDBDocumentClient;
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
}

/** tick (1 invocation) 内の tenant flag 読み取り cache。 */
export type TenantFlagCache = Map<string, Promise<boolean>>;
/** tick 内の `${eventId}#${teamId}` → Gate 完了済みか の cache。 */
export type GateCompletionCache = Map<string, Promise<boolean>>;

function isGateFlagEnabled(
  shared: GateScoringShared,
  cache: TenantFlagCache,
  tenantId: string,
): Promise<boolean> {
  const cached = cache.get(tenantId);
  if (cached) return cached;
  // [#2450] cold-start cache 済みの async resolver (`controlDataRuntime`) 経由で FeatureFlags
  // repository を解決するため `CONTROL_DATA_BACKEND=turso|sql` でも動作する。 default backend では
  // 従来と byte 互換の GetCommand が飛ぶ。 tick (1 invocation) 内 cache の構造は不変 —
  // cache に入れる `Promise<boolean>` の構築だけ `.then()` 連結にする。
  const promise = controlDataRuntime
    .resolveFeatureFlagsRepository({ ddb: shared.ddb, eventsTableName: shared.eventsTableName })
    .then((repo) => isTenantFeatureEnabled(repo, tenantId, CHALLENGE_PREREQUISITE_GATE_FLAG));
  cache.set(tenantId, promise);
  return promise;
}

/**
 * Gate challenge の行なら完了を latch し、 必要なら bonus を 1 度だけ加算する。
 * Gate challenge 以外の行は no-op。
 */
export async function maybeLatchGateCompletion(
  shared: GateScoringShared,
  item: Partial<DeploymentItem>,
  progressionGate: ProgressionGateConfig | undefined,
  nowIso: string,
  flagCache: TenantFlagCache,
): Promise<void> {
  if (!progressionGate) return;
  if (!item.problemId || item.problemId !== progressionGate.gateProblemId) return;
  if (!item.PK || !item.jobId || !item.tenantId) return;
  if (!isGateCompleted(item)) return;

  await latchCompletedAt(shared, item as GateRow, nowIso);

  // 完了 bonus (flag ON + completionBonus > 0 の team のみ、 1 回だけ)。
  if (typeof item.gateBonusAwardedAt === "string") return;
  const { completionBonus } = resolveTeamGatePolicy(progressionGate, item.teamId);
  if (completionBonus <= 0) return;
  if (!(await isGateFlagEnabled(shared, flagCache, item.tenantId))) return;
  await awardBonusTransact(shared, item as GateRow, completionBonus, nowIso);
}

type GateRow = Partial<DeploymentItem> & { PK: string; jobId: string; problemId: string };

/** 完了 latch (one-time)。 既に latch 済みなら skip。 レースは condition で防ぐ。 */
async function latchCompletedAt(
  shared: GateScoringShared,
  item: GateRow,
  nowIso: string,
): Promise<void> {
  if (typeof item.gateCompletedAt === "string") return;
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.deploymentsTableName,
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression: "SET gateCompletedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(gateCompletedAt)",
        ExpressionAttributeValues: { ":now": nowIso },
      }),
    );
  } catch (err) {
    if (!(err instanceof Error && err.name === "ConditionalCheckFailedException")) throw err;
  }
}

/** score ADD + 履歴行 append を 1 transaction に (= 片方だけ成功する分裂を防ぐ)。 */
async function awardBonusTransact(
  shared: GateScoringShared,
  item: GateRow,
  completionBonus: number,
  nowIso: string,
): Promise<void> {
  const scoreEvent = buildScoreEventItem(
    {
      jobId: item.jobId,
      problemId: item.problemId,
      teamId: item.teamId,
      eventId: item.eventId,
      expiresAt: item.expiresAt ?? 0,
    },
    "gate-bonus",
    completionBonus,
    nowIso,
  );
  try {
    await shared.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: shared.deploymentsTableName,
              Key: { PK: item.PK, SK: "META" },
              UpdateExpression: "ADD score :bonus SET gateBonusAwardedAt = :now, updatedAt = :now",
              ConditionExpression: "attribute_not_exists(gateBonusAwardedAt)",
              ExpressionAttributeValues: { ":bonus": completionBonus, ":now": nowIso },
            },
          },
          { Put: { TableName: shared.deploymentsTableName, Item: scoreEvent } },
        ],
      }),
    );
  } catch (err) {
    // 並行 tick が先に付与した (condition fail) / transient throttle — どちらも swallow。
    // gateBonusAwardedAt が未設定のまま失敗した場合は次 tick が transaction ごと retry する。
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      console.warn("[gate-bonus] transact canceled (already awarded or transient)", {
        jobId: item.jobId,
        message: err.message,
      });
      return;
    }
    throw err;
  }
}

/**
 * unlock target の deployment が Gate 未完了 (= locked) で採点を skip すべきか判定する。
 * Gate 設定なし / target 外 / policy off / flag OFF は false (= 従来どおり採点)。
 *
 * team の Gate 行は対象行の GSI2PK (TEAMKEY#...) で Query して引く (invocation 内 cache)。
 * GSI2PK が無い行 (= sparse 化済み / teardown 中) は完了を確認できないので locked 扱い
 * (= fail-closed。 scoringLocked の fail-closed と同じ向き: 不確かな状態で加点しない)。
 */
export async function isLockedForScoring(
  shared: GateScoringShared,
  item: Partial<DeploymentItem>,
  progressionGate: ProgressionGateConfig | undefined,
  flagCache: TenantFlagCache,
  completionCache: GateCompletionCache,
): Promise<boolean> {
  if (!progressionGate || !item.problemId || !item.teamId || !item.tenantId || !item.eventId) {
    return false;
  }
  if (!progressionGate.unlockTargetIds.includes(item.problemId)) return false;
  const { policy } = resolveTeamGatePolicy(progressionGate, item.teamId);
  if (policy === "off") return false;
  if (!(await isGateFlagEnabled(shared, flagCache, item.tenantId))) return false;

  const key = `${item.eventId}#${item.teamId}`;
  let completed = completionCache.get(key);
  if (!completed) {
    completed = fetchGateCompleted(shared, item, progressionGate);
    completionCache.set(key, completed);
  }
  return !(await completed);
}

async function fetchGateCompleted(
  shared: GateScoringShared,
  item: Partial<DeploymentItem>,
  config: ProgressionGateConfig,
): Promise<boolean> {
  const teamKey =
    typeof item.GSI2PK === "string" && item.GSI2PK.length > 0 ? item.GSI2PK : undefined;
  if (!teamKey) return false;
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.deploymentsTableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": teamKey },
    }),
  );
  const rows = (out.Items ?? []) as Partial<DeploymentItem>[];
  // 完了済 Gate を teardown しても latch 行 (gateCompletedAt) を拾って完了を保持する
  // (participant guard の selectGateCompletionRow と同じ durable 判定 → 挙動を揃える)。
  return isGateCompleted(selectGateCompletionRow(rows, config.gateProblemId));
}
