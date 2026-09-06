import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  DeploymentsCoordinationPort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import type { EventScoringMeta } from "../../control-data/events-repository.js";
import {
  type ControlDataRuntime,
  createDefaultControlDataRuntime,
} from "../../control-data/runtime-repositories.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  buildScheduledDeployResources,
  buildScheduledTeardownResources,
  resolveEventsRepository,
} from "../event-handler/shared.js";
import { applyKindResult } from "./apply-kind-result.js";
import { dispatchCompositeReadyTargets } from "./composite-ready-dispatch.js";
import { reconcileDeployStatusMaintenance } from "./composite-status-reconciler.js";
import { maybeFireConditionDisruptions } from "./condition-disruption-fire.js";
import { createCoordinationTickPass, parseCoordinationProblemIds } from "./coordination-tick.js";
import { createLambdaTickInvoker } from "./coordination-tick-dispatch.js";
import {
  applyDisruptionEffects,
  type DisruptionAuditRowLike,
  dedupeEffectsByDisruptionId,
  resolveOperatorEffects,
} from "./disruption-effects.js";
import { reconcileEventStatuses } from "./event-reconciler.js";
import {
  type GateCompletionCache,
  isLockedForScoring,
  maybeLatchGateCompletion,
  type TenantFlagCache,
} from "./gate-completion-bonus.js";
import { runAttackDetectionKind } from "./kinds/attack-detection.js";
import { runPhasedPollingKind } from "./kinds/phased-polling.js";
import { runUptimeFlatKind } from "./kinds/uptime-flat.js";
import { runUptimeMultiKind } from "./kinds/uptime-multi.js";
import { parsePhasesEnv } from "./phases-env.js";
import { reconcileRuntimeStatuses } from "./runtime-status-reconciler.js";
import { isScoringActive } from "./scoring-active.js";
import {
  type ActiveDisruptionEffect,
  buildSharedResources,
  type DeploymentScoringState,
  type GenericScoringSharedResources,
  type KindHandlerInput,
  type KindResult,
  type PhaseEntry,
  parseScoringState,
  resolveDeploymentsRepository,
  resolveDisruptionsRepository,
  resolveProblemEndpointsRepository,
} from "./shared.js";

/**
 * Generic scoring dispatcher Lambda (旧 health-check-handler の責務を引き継ぐ)。
 *
 * EventBridge Scheduler `rate(1 minute)` で起動。 2 つの責務を並列で動かす:
 *
 * 1. **採点 dispatch**: Deployments table を Scan し、 `status=COMPLETE` な行について
 *    `metadata.scoring.kind` を読み、 5 種の builtin kind handler に dispatch する。
 *    - `flag`              → polling では何もしない (= submit-flag が event-triggered で扱う)
 *    - `uptime-flat` / `uptime` → endpoint 群を probe、 全 ok で pointsPerSuccess 加点
 *    - `uptime-multi`      → N slot probe、 全 ok で pointsAllOk / 1 fail で failurePenalty
 *    - `phased-polling`    → time-based rule + platform 分類 + bonus
 *    - `attack-detection`  → CFn Output 内 counter の増分で加点
 *
 * 2. **Event status reconcile** (#557 #539): Events table の `DEPLOYING` / `TEARDOWN` 行を
 *    子 deployment 集約 status で `READY` / `ARCHIVED` に遷移させる。
 *
 * 両者は別 table / 別 row で独立。 `Promise.all` で並列実行する。
 *
 * MVP-1 規模 (~50 deployments) は Scan + FilterExpression で十分。 Phase 2+ で 100+ になったら
 * GSI3 (PK=STATUS) で query 化を検討。
 */

// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance
// (cold-start SQL executor cache preserved), injected into every shared-resources build.
const controlDataRuntime = createDefaultControlDataRuntime();

export async function handler(): Promise<void> {
  const shared = buildSharedResources(controlDataRuntime);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Event status reconcile (#557 #539) を採点と並列実行。1 tick の失敗は次 tick で再評価。
  // teardownDeps を渡すと teardownAt 経過の event を自動撤去する。 CompetitorAccounts env が
  // 未配線なら buildScheduledTeardownResources が undefined を返し、 scheduled teardown は dormant。
  // deployDeps を渡すと deployAt 経過の DRAFT event を自動 deploy する。 Teams /
  // catalog env が未配線なら buildScheduledDeployResources が undefined を返し、 scheduled deploy は dormant。
  const reconcilePromise = reconcileEventStatuses(
    {
      runtime: shared.runtime,
      ddb: shared.ddb,
      eventsTableName: shared.eventsTableName,
      deploymentsTableName: shared.deploymentsTableName,
      teardownDeps: buildScheduledTeardownResources(shared.runtime),
      deployDeps: buildScheduledDeployResources(shared.runtime),
    },
    nowIso,
  ).catch((err) => {
    console.warn("[generic-scoring] reconcileEventStatuses failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // [#1410-1412] 非 AWS runtime (sakura/azure/gcp) deployment の status / outputs を
  // adapter.getStatus / collectOutputs で reconcile (= State Machine が無いので tick が進める)。 採点と並列。
  // [#2747] その直後に Composite DAG の後続 wave を dispatch する (= 直前で refresh した target
  // status を見て、 依存が揃った target を起動する)。 [#2068] その後に Composite parent の status
  // を target 群から集約 reconcile する (= per-target の後)。
  const runtimeReconcilePromise = reconcileDeployStatusMaintenance(
    shared,
    nowIso,
    () =>
      reconcileRuntimeStatuses(shared, nowIso).catch((err) => {
        console.warn("[generic-scoring] reconcileRuntimeStatuses failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }),
    () =>
      dispatchCompositeReadyTargets(shared, nowMs).catch((err) => {
        console.warn("[generic-scoring] dispatchCompositeReadyTargets failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }),
  ).catch((err) => {
    console.warn("[generic-scoring] reconcileCompositeParents failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // metadata.json の `phases[]` は scoring とは別 field なので、 dispatcher で per-problemId
  // に展開する。Phase 3.B では `BATTLE_PROBLEMS_PHASES` env で渡す (= Lambda 配線で
  // discoverProblemsPhases から JSON 化)。env が無い場合は空 (= phases 無し)。
  const phasesByProblemId = parsePhasesEnv(process.env.BATTLE_PROBLEMS_PHASES);

  // [#1665] operator-fired disruption の active 採点効果を event ごとに 1 度だけ query して
  // (`${eventId}#${teamId}#${problemId}` 別に) 解決する。 disruptions table 未配線なら空 (= 無効・後方互換)。
  const operatorEffects = new Map<string, ActiveDisruptionEffect[]>();
  const queriedEvents = new Set<string>();

  // [#2283] Progression Gate 用の invocation-scoped cache: per-tenant feature flag (tenant
  // ごとに 1 read) + per-(event, team) の Gate 完了判定 (team ごとに 1 GSI2 Query)。
  const tenantFlagCache: TenantFlagCache = new Map();
  const gateCompletionCache: GateCompletionCache = new Map();

  // [#2324] scoring-driven coordination tick。資格情報分離のため採点 Lambda は
  // plugin を実行せず、 tick 対象を集めて最小 IAM の CoordinationDispatcher を 1 回 async Invoke するだけ。
  const deploymentsRepository: DeploymentsQueryPort & DeploymentsCoordinationPort =
    await resolveDeploymentsRepository(shared);
  const coordinationTick = createCoordinationTickPass(
    createLambdaTickInvoker(),
    process.env.COORDINATION_DISPATCHER_FUNCTION_NAME ?? "",
    parseCoordinationProblemIds(process.env.PROBLEM_COORDINATION),
    deploymentsRepository,
  );

  // [Issue #2441 / Phase B3] `forEachCompleteDeploymentPage` absorbs the
  // 200-per-page Scan + `LastEvaluatedKey` drain into the Deployments seam;
  // per-page BatchGet / parallel processing below stays unchanged.
  await deploymentsRepository.forEachCompleteDeploymentPage(async (page) => {
    const items = page as Partial<DeploymentItem>[];

    coordinationTick.collect(items, nowIso); // [#2324] tick 対象を per-page で集約 (= 1 event 1 tick)。

    // #558: deployment が属する event の `scoringLocked` を per-invocation で BatchGet 取得。
    // #2283: 同じ BatchGet で progressionGate (Gate 完了 bonus 用) も引く。
    const eventMetaMap = await fetchEventScoringMetaMap(shared, items);
    await loadOperatorEffects(shared, items, queriedEvents, operatorEffects, nowMs);

    await Promise.all(
      items.map(async (item) => {
        const key = `${item.eventId ?? ""}#${item.teamId ?? ""}#${item.problemId ?? ""}`;
        await processDeployment(
          shared,
          item,
          eventMetaMap,
          phasesByProblemId,
          operatorEffects.get(key) ?? [],
          { tenantFlagCache, gateCompletionCache },
          nowMs,
          nowIso,
        ).catch((err) => {
          console.warn(`[generic-scoring] processDeployment failed jobId=${item.jobId}`, {
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }),
    );
  });

  // [#2324] coordination tick は scan で集めた target に依存するため scan 後に起動する。
  const coordinationPromise = coordinationTick.run(nowMs, nowIso);

  await Promise.all([reconcilePromise, runtimeReconcilePromise, coordinationPromise]);
}

/** 採点効果の最大 window (1h)。 これより古い audit 行は active になりえない。 */
const OPERATOR_EFFECT_WINDOW_MS = 60 * 60 * 1000;

/**
 * [#1665] この page の deployment が属する各 event について (未 query のものだけ) disruptions
 * audit table を query し、 operator-fired disruption の active 採点効果を解決して `out` に蓄積する。
 * key は `${eventId}#${teamId}#${problemId}`。
 *
 * [Issue #2442 / Phase C3] DDB アクセスは repository seam (`resolveDisruptionsRepository`) に
 * 移設。 `disruptionsTableName` が空文字なのは 2 通り — pure SQL backend 選択時 (= 正常、 seam が
 * SQL executor 直結で処理する) と旧 deploy chain (= 真の未配線) — を injected `shared.runtime.
 * needsManualPrune()` (= pure SQL 選択中かの既存 public predicate、 #2440) で区別する
 * (`problem-endpoints-handler/endpoints.ts` の `isEndpointsRegistryUnconfigured` と同型)。
 * 未配線ならこの Lambda 呼び出し全体を壊さないよう no-op で抜ける (= 従来の dormant 挙動を維持)。
 */
async function loadOperatorEffects(
  shared: GenericScoringSharedResources,
  items: readonly Partial<DeploymentItem>[],
  queriedEvents: Set<string>,
  out: Map<string, ActiveDisruptionEffect[]>,
  nowMs: number,
): Promise<void> {
  if (!shared.disruptionsTableName && !shared.runtime.needsManualPrune()) return;
  const sinceIso = new Date(nowMs - OPERATOR_EFFECT_WINDOW_MS).toISOString();
  const eventIds = new Set<string>();
  for (const it of items) {
    if (typeof it.eventId === "string" && it.eventId.length > 0 && !queriedEvents.has(it.eventId)) {
      eventIds.add(it.eventId);
    }
  }
  if (eventIds.size === 0) return;
  const repository = await resolveDisruptionsRepository(shared);
  for (const eventId of eventIds) {
    queriedEvents.add(eventId);
    const rows: readonly DisruptionAuditRowLike[] = await repository.listAuditSince(
      eventId,
      sinceIso,
    );
    for (const [teamProblem, effects] of resolveOperatorEffects(
      rows,
      shared.problemsDisruptions,
      nowMs,
    )) {
      out.set(`${eventId}#${teamProblem}`, effects);
    }
  }
}

/**
 * 1 deployment を 5 kind dispatcher で採点。`scoring` が無い問題は no-op。
 * `eventStartsAt` / `eventEndsAt` で gate、 `scoringLocked` event は skip。
 */
async function processDeployment(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  eventMetaMap: Map<string, EventScoringMeta>,
  phasesByProblemId: Record<string, readonly PhaseEntry[]>,
  operatorEffects: readonly ActiveDisruptionEffect[],
  gateCaches: { tenantFlagCache: TenantFlagCache; gateCompletionCache: GateCompletionCache },
  nowMs: number,
  nowIso: string,
): Promise<void> {
  if (!item.problemId || !item.tenantId || !item.teamId) {
    // Phase 1 以前の旧 deployment は teamId / eventId を持たない → 採点 skip
    return;
  }
  if (!isScoringActive(item, nowIso)) return;
  const eventMeta = item.eventId ? eventMetaMap.get(item.eventId) : undefined;
  if (eventMeta?.scoringLocked === true) return;

  // [#2283] Progression Gate: Gate 行の完了 latch + bonus / locked target の採点 skip。
  if (await applyProgressionGateTick(shared, item, eventMeta, nowIso, gateCaches)) return;

  const scoring = shared.problemsScoring[item.problemId];
  if (!scoring || !isRuntimeScoringKind(scoring.kind)) return;

  const slots = shared.problemsEndpoints[item.problemId] ?? [];
  // Phase 3.A: 当該 (tenant, team, problem) の override 行を query (= 1 RCU 程度)
  const overrides = await queryOverridesForDeployment(
    shared.runtime,
    shared.ddb,
    shared.endpointsTableName,
    item.tenantId,
    item.teamId,
    item.problemId,
  );

  const prevState = parseScoringState(item.scoringState);

  const input: KindHandlerInput = {
    deployment: item,
    scoring,
    slots,
    overrides,
    phases: phasesByProblemId[item.problemId] ?? [],
    nowMs,
    nowIso,
    prevState,
  };

  const kindResult = await dispatchKindHandler(input);
  if (!kindResult) return;
  let result = kindResult;

  // [#1665] active な disruption 採点効果 (condition-fired + operator-fired) を畳み込む。
  // active 効果が無い問題は完全に挙動不変 (= 余分な scoringState write を出さない)。
  result = foldActiveDisruptionEffects(result, prevState, operatorEffects, nowMs);

  await applyKindResult(shared, item, result, nowIso);

  // #1422: 採点後の score / phase / 経過分で condition-triggered disruption を
  // 評価し、 成立した disruption を in-account event bus に発火する (= cross-account forward は #1419)。
  // score 書き込み (applyKindResult) の後に走らせ、 publish 失敗は outer processDeployment の .catch
  // に委ねる (= score は確定済、 disruption は次 tick で再評価)。
  await maybeFireConditionDisruptions(
    shared,
    item,
    result,
    prevState,
    phasesByProblemId,
    nowMs,
    nowIso,
  );
}

/**
 * scoring kind → kind handler の dispatch。 未知 kind (flag / multi-flag / composite 等の
 * polling 対象外) は `undefined` (= 呼び出し側で no-op)。
 */
async function dispatchKindHandler(input: KindHandlerInput): Promise<KindResult | undefined> {
  const scoring = input.scoring;
  if (scoring.kind === "uptime" || scoring.kind === "uptime-flat") {
    return runUptimeFlatKind({ ...input, scoring });
  }
  if (scoring.kind === "uptime-multi") {
    return runUptimeMultiKind({ ...input, scoring });
  }
  if (scoring.kind === "phased-polling") {
    return runPhasedPollingKind({ ...input, scoring });
  }
  if (scoring.kind === "attack-detection") {
    return runAttackDetectionKind({ ...input, scoring });
  }
  return undefined;
}

function isRuntimeScoringKind(kind: string): boolean {
  return (
    kind === "uptime" ||
    kind === "uptime-flat" ||
    kind === "uptime-multi" ||
    kind === "phased-polling" ||
    kind === "attack-detection"
  );
}

/**
 * [#2283] Progression Gate の tick 内処理。
 *   - Gate challenge 行なら完了 latch (gateCompletedAt) + 完了 bonus (1 team 1 回)
 *   - unlock target 行なら Gate 未完了の間 `true` を返して採点を skip させる
 *     (= 参加者が触れない locked 問題に自動で加点 / 減点しない)
 */
async function applyProgressionGateTick(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  eventMeta: EventScoringMeta | undefined,
  nowIso: string,
  gateCaches: { tenantFlagCache: TenantFlagCache; gateCompletionCache: GateCompletionCache },
): Promise<boolean> {
  await maybeLatchGateCompletion(
    shared,
    item,
    eventMeta?.progressionGate,
    nowIso,
    gateCaches.tenantFlagCache,
  );
  return isLockedForScoring(
    shared,
    item,
    eventMeta?.progressionGate,
    gateCaches.tenantFlagCache,
    gateCaches.gateCompletionCache,
  );
}

/**
 * [#1665] active な disruption 採点効果を KindResult に畳み込む。 2 ソースを統合する:
 *   - condition-triggered: deployment の `scoringState.activeEffects` (= maybeFireConditionDisruptions が記録)
 *   - operator-fired: disruptions audit table から毎 tick 解決した効果 (= 永続せず derive)
 * 同一 disruptionId は dedupe して二重減点を防ぐ。 condition 効果だけを永続 (operator は次 tick で再 derive)、
 * 期限切れは prune。 どちらの効果も無い deployment は素通し (= 完全な後方互換)。 pure。
 */
function foldActiveDisruptionEffects(
  result: KindResult,
  prevState: DeploymentScoringState,
  operatorEffects: readonly ActiveDisruptionEffect[],
  nowMs: number,
): KindResult {
  const conditionSurviving = (prevState.activeEffects ?? []).filter((e) => e.expiresAtMs > nowMs);
  const conditionExpiredSome = (prevState.activeEffects?.length ?? 0) !== conditionSurviving.length;
  const combined = dedupeEffectsByDisruptionId([...conditionSurviving, ...operatorEffects]);
  if (combined.length === 0 && !conditionExpiredSome) return result;

  const { result: penalized } = applyDisruptionEffects(result, combined, nowMs);
  // condition 効果だけを永続する (operator は audit から毎 tick 再 derive する)。 期限切れは prune。
  let newState = penalized.newState;
  if (conditionSurviving.length > 0 || conditionExpiredSome) {
    const { activeEffects: _drop, ...base } = penalized.newState ?? prevState;
    newState =
      conditionSurviving.length > 0
        ? { ...base, activeEffects: conditionSurviving }
        : Object.keys(base).length > 0
          ? base
          : undefined;
  }
  return { ...penalized, newState };
}

/**
 * 1 (tenant, team, problem) の override 行を全件引く (= slot 数 << 10)。
 *
 * [Issue #2442 / Phase C1] raw `QueryCommand` は `resolveProblemEndpointsRepository`
 * (control-data seam) 経由に置き換えた。`tableName` が空文字なのは 2 通りある:
 *   - pure SQL backend (`turso`) 選択時 — table 自体が synth されず env も配線されない
 *     (= 正常。 injected `runtime.needsManualPrune()` が true を返す — A5 で導入した
 *     既存 predicate を再利用して pure backend かどうかを判定する)
 *   - dynamodb backend で本当に未配線 (= 旧来の「機能無効」状態)
 * 後者だけ `[]` に degrade する (= 1 mis-wired site が tick 全体を落とさない、既存挙動を維持)。
 * pure backend は tableName を無視して seam が SQL executor 直結で解決するため、素通りする。
 */
export async function queryOverridesForDeployment(
  runtime: ControlDataRuntime,
  ddb: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  teamId: string,
  problemId: string,
): Promise<{ readonly slot: string; readonly overrideUrl: string }[]> {
  if (!tableName && !runtime.needsManualPrune()) return [];
  try {
    const repo = await resolveProblemEndpointsRepository({
      runtime,
      ddb,
      endpointsTableName: tableName,
    });
    const rows = await repo.queryOverrides(tenantId, teamId, problemId);
    return rows
      .filter(
        (r): r is typeof r & { overrideUrl: string } =>
          typeof r.overrideUrl === "string" && r.overrideUrl.length > 0,
      )
      .map((r) => ({ slot: r.slot, overrideUrl: r.overrideUrl }));
  } catch (err) {
    // 旧: return [] (= 採点を default URL で続行) は、 競技者が override 済なのに古い
    // default に対して silent-wrong-data scoring が走るリスクがある。 throw して outer
    // processDeployment の .catch (= 1 tick skip + warn log) に委ねる (= 次 tick で retry)。
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`queryOverrides failed for ${tenantId}/${teamId}/${problemId}: ${msg}`, {
      cause: err,
    });
  }
}

/**
 * #558: 同 invocation 内 deployments の distinct eventId について、 repository seam
 * (`batchGetEvents`) で eventId → { scoringLocked, progressionGate } の Map を取得する。
 *
 * Phase 3.B で health-check-handler から本 module へ relocate (= 動作不変)。
 * #2283 で progressionGate (Gate 完了 bonus 用) を同じ BatchGet に相乗りさせた。
 * [#2438 / Phase A3] BatchGet 自体は repository seam に移設済み — 本関数が持つのは
 * fail-closed policy (下記 catch) のみ。
 */
async function fetchEventScoringMetaMap(
  shared: GenericScoringSharedResources,
  items: readonly Partial<DeploymentItem>[],
): Promise<Map<string, EventScoringMeta>> {
  const eventIds = Array.from(
    new Set(
      items
        .map((i) => i.eventId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (eventIds.length === 0) return new Map();
  // [#2438] repository の解決 (backend 選択) はここで行う — CONTROL_DATA_BACKEND の設定ミス /
  // SQL 未配線のような setup エラーは下の try に入れない (fail-closed の対象は read failure のみ)。
  // config エラーを fail-closed に畳むと「ロック中」と誤認させたまま原因を隠してしまう。
  // [#2450] resolver は async 化したが await は try の外のまま — setup エラーは fail-closed に
  // 畳まず outer processDeployment の .catch (= 1 tick skip + warn) に委ねる (A3 の設計判断を維持)。
  const repository = await resolveEventsRepository(shared);
  try {
    return new Map(await repository.batchGetEvents(eventIds));
  } catch (err) {
    // #558 の scoring lock 契約: operator が「ロック中」とマークした event に points を加算
    // しないことを保証する。 lock 状態が読めない (= transient DDB error) ときに fail-open
    // で「全 event 未ロック扱い」してしまうと、 ロック中 event にも加点してしまう。
    // fail-closed として本 batch の全 eventId を locked 扱いにし、 該当 deployment の
    // 採点を 1 tick skip させる (= 次 tick で retry。 gate bonus も同様に次 tick へ持ち越し)。
    console.warn(
      "[generic-scoring] fetchEventScoringMetaMap failed (fail-closed: treat batch as locked)",
      {
        message: err instanceof Error ? err.message : String(err),
      },
    );
    return new Map(
      eventIds.map((id) => [id, { scoringLocked: true, progressionGate: undefined }] as const),
    );
  }
}

export {
  reconcileEventStatuses,
  resolveEventStatusTransition,
} from "./event-reconciler.js";

export { parsePhasesEnv } from "./phases-env.js";
// Re-export pure helpers for tests
export { isScoringActive } from "./scoring-active.js";
