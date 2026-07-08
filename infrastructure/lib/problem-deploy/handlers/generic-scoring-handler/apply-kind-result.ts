import type { DeploymentItem } from "../deploy-handler/types.js";
import { buildScoreEventRecord } from "../shared/score-event.js";
import {
  type GenericScoringSharedResources,
  type KindResult,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * KindResult を deployment 行に書き戻す。 score 加算 / endpointsHealth 更新 / lastResult 更新 /
 * scoringState 更新 を 1 UpdateItem で atomic に行う。 続けて score event 行 (= ulid SK の sparse row)
 * を append する。
 *
 * #1244: 旧実装は UpdateItem 失敗を console.warn + return で握り潰し、 さらに writeScoreEvent
 * 失敗も warn のみで swallow していた。 結果として portal の score / timeline 不整合の温床に
 * なっていたため、 失敗は log した上で throw する (= 1 deployment の失敗は outer の
 * `processDeployment` `.catch` で他 deployment と隔離されるが、 CloudWatch には残り
 * EventBridge 次 tick で retry される)。 AGENTS.md 「モック / スタブで握り潰す fallback 禁止」
 * に整合。
 *
 * [Issue #2441 / Phase B2] The dynamic ADD/SET expression this used to build
 * inline (`buildKindResultUpdate`, now removed as dead code) lives verbatim
 * inside `DeploymentsRepository.applyKindScoringResult` instead — the seam
 * requires `jobId` (it derives the physical key itself), so the guard below now
 * also skips when `jobId` is absent. Every real Scan row always carries `jobId`
 * (it is written at deploy time and never removed); a PK-without-jobId row
 * cannot occur outside a synthetic test fixture, so this tightens rather than
 * changes production behavior.
 *
 * [Issue #2441 / Phase B3] `item` now flows from
 * `DeploymentsRepository.forEachCompleteDeploymentPage`, whose `DeploymentRecord`
 * never carries the physical `PK` (it is a backend implementation detail the
 * seam hides) — the old `!item.PK` half of this guard would now always be
 * true, silently short-circuiting the whole tick. Dropped; `jobId` alone is
 * the correct — and now the only reachable — precondition.
 */
export async function applyKindResult(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
  nowIso: string,
): Promise<void> {
  if (!item.jobId) return;

  const repository = await resolveDeploymentsRepository(shared);
  await repository.applyKindScoringResult(item.jobId, result, nowIso);

  // score event 行 (= 履歴 marker) を append。失敗は throw して outer
  // `processDeployment` の .catch (= 1 tick skip + warn log) に委ねる (= 次 tick で retry)。
  await appendKindScoreEvents(shared, item, result);
}

export async function appendKindScoreEvents(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
): Promise<void> {
  if (!item.jobId || !item.problemId) return;
  const parent = {
    jobId: item.jobId,
    problemId: item.problemId,
    teamId: item.teamId,
    eventId: item.eventId,
    expiresAt: item.expiresAt ?? 0,
  };
  // [Issue #2441 / Phase B3] `appendScoreEvent` replaces the direct
  // `writeScoreEvent(ddb, tableName, ...)` I/O call — same resolved repository
  // as `applyKindScoringResult` above.
  const repository = await resolveDeploymentsRepository(shared);
  for (const ev of result.scoreEvents) {
    // #1244: 失敗は log + throw。 上位 (= processDeployment の .catch) で 1 deployment 単位に
    // 隔離されるので他 deployment の採点は止まらないが、 score event 抜けは CloudWatch に
    // 残り、 次 tick で同 source が再評価されたときに再書き込みされる。
    try {
      await repository.appendScoreEvent(
        buildScoreEventRecord(parent, ev.source, ev.points, ev.occurredAt),
      );
    } catch (err) {
      console.error(`[generic-scoring] score-event write failed jobId=${item.jobId}`, {
        source: ev.source,
        points: ev.points,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
