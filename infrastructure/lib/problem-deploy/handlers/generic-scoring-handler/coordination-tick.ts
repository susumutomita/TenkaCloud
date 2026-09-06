import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import { isCoordinationStateEnvelope } from "../../control-data/domain/coordination-state-envelope.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { resolveCurrentCoordinationRunId } from "../shared/coordination-run.js";
import {
  COORDINATION_TICK_ACTION,
  type CoordinationTickBatch,
} from "../shared/coordination-tick-contract.js";
import type { CoordinationTickInvoker } from "./coordination-tick-dispatch.js";
import { isRoundTerminated } from "./round-liveness.js";

/**
 * scoring-driven tick (#2324) の **採点 pass 側**。 coordination を宣言した event を per-minute
 * pass で見つけ、各 scope を CoordinationDispatcher Lambda へ async Invoke する。
 *
 * 資格情報分離: 採点 Lambda は ssm:GetParameter / kms:Decrypt を持つため、 pack-author
 * 由来の plugin を **ここでは load / 実行しない**。 「どの event が coordination を宣言しているか」だけを
 * `PROBLEM_COORDINATION` config (= problemId 集合、 plugin code ではない純 metadata) で判定し、 実 tick
 * (plugin の runTick) は最小 IAM の dispatcher に委ねる (= op 経路と同じ場所)。終了済みの scope は
 * 保存済みの得点が残る間だけ配送する。対象が 0 なら invoke しない。
 */

/** scan で集めた 1 event 分の tick 対象 (= wire 送出前の内部形。 eventNowMs は送出時に算出)。 */
export interface CollectedTickTarget {
  readonly tenantId: string;
  readonly eventId: string;
  readonly moduleRef: string;
  /** event 開始時刻 (epoch ms)。 送出時に `eventNowMs = nowMs - eventStartMs` へ変換する。 */
  readonly eventStartMs: number;
  readonly teamIds: string[];
  readonly drainOnly?: boolean;
}

/** per-minute pass に差し込む driver (= scan 後に active と保存済み pending を配送する)。 */
export interface CoordinationTickPass {
  /** scan 1 ページから tick 対象を集約する (= per-page で呼ぶ)。 */
  collect(items: readonly Partial<DeploymentItem>[], nowIso: string): void;
  /** active を先に送り、終了済みは保存済み pending を見つけた場合だけ送る。 */
  run(nowMs: number, nowIso: string): Promise<void>;
}

/**
 * `PROBLEM_COORDINATION` (= `{ [problemId]: { plugin } }` config を build 時 inline した JSON) から、
 * coordination を宣言した problemId 集合を取り出す。 これは plugin code ではなく宣言 metadata なので、
 * 採点 Lambda に持たせても資格情報分離を壊さない (= dispatcher が使う config と同一 source)。
 * 未設定 / 不正 JSON / 非 object は空集合 (= tick 対象なし)。
 */
export function parseCoordinationProblemIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed as Record<string, unknown>));
    }
  } catch {
    return new Set();
  }
  return new Set();
}

/**
 * scan 1 ページの deployment 群から tick 対象を (event, problem) 単位で収集する (= 集約)。
 * coordination を宣言した問題の COMPLETE deployment を dedupe し、 採点対象でない event は
 * `isScoringActive` (start gate + 終端 gate) で除外する。
 *
 * [Issue #3123] dedupe key は以前 `${tenantId}#${eventId}` だった。 1 event が coordination 問題を
 * 2 つ deploy すると、
 *
 *   1. 先に見つかった問題の target だけが残り、 2 つ目は tick 対象から黙って落ちる
 *      (= 契約が発行されず、 phase も進まず、 試合が終わらない)。
 *   2. さらに 2 つ目の問題のチームが 1 つ目の `teamIds` に merge され、 その roster で
 *      `initialState` が組まれる (= その問題を遊んでいないチームが state に現れる)。
 *
 * key に problem を含めることが、 state を namespace 分割した #3123 の tick 側の対。 片方だけでは
 * 「state は分かれているが時計は 1 つ」 という状態になる。
 */
export function collectCoordinationTickTargets(
  coordinationProblemIds: ReadonlySet<string>,
  items: readonly Partial<DeploymentItem>[],
  out: Map<string, CollectedTickTarget>,
  nowIso: string,
  ended?: Map<string, CollectedTickTarget>,
): void {
  if (coordinationProblemIds.size === 0) return;
  for (const item of items) {
    const candidate = toTickCandidate(coordinationProblemIds, item, nowIso);
    if (!candidate) continue;
    const destination = candidate.drainOnly ? ended : out;
    if (!destination) continue;
    // JSON 配列 key: `#` 連結だと、 `#` を含む id (= 現状の validation では起きないが、 key builder
    // 側と同じ理由で不変条件に依存しない) が別 namespace と衝突しうる。
    const key = JSON.stringify([candidate.tenantId, candidate.eventId, candidate.moduleRef]);
    const existing = destination.get(key);
    if (existing) {
      if (!existing.teamIds.includes(candidate.teamId)) existing.teamIds.push(candidate.teamId);
      continue;
    }
    destination.set(key, {
      tenantId: candidate.tenantId,
      eventId: candidate.eventId,
      moduleRef: candidate.moduleRef,
      eventStartMs: candidate.eventStartMs,
      teamIds: [candidate.teamId],
      ...(candidate.drainOnly ? { drainOnly: true } : {}),
    });
  }
}

/** 1 deployment を tick 候補 (= 検証済みフィールド) に写す。 対象外 (= 未宣言 / 未開始 等) は null。 */
interface TickCandidate {
  readonly tenantId: string;
  readonly eventId: string;
  readonly moduleRef: string;
  readonly eventStartMs: number;
  readonly teamId: string;
  readonly drainOnly?: boolean;
}
function toTickCandidate(
  coordinationProblemIds: ReadonlySet<string>,
  item: Partial<DeploymentItem>,
  nowIso: string,
): TickCandidate | null {
  const { tenantId, eventId, problemId, teamId, eventStartsAt } = item;
  if (!tenantId || !eventId || !problemId || !teamId) return null;
  if (!coordinationProblemIds.has(problemId)) return null;
  // typeof は下の Date.parse 用の narrowing (gate 本体は isScoringActive が持つ)。
  if (typeof eventStartsAt !== "string" || nowIso < eventStartsAt) return null;
  // [Issue #3123] 採点 pass (`index.ts` の `isScoringActive`) と同じ gate を使う。 start だけを
  // 見ていた頃は、 終了済み event の deployment 行が teardown まで `COMPLETE` のまま残るため、
  // 終わった試合を tick し続けていた:
  //
  //   1. tick が TTL を延ばし続けるので、 retention の起点が「event が静かになった時刻」に
  //      ならず、 teardown を取りこぼした namespace が無期限に残る。
  //   2. `tick` を実装した plugin は、 採点が止まった後も state を進めてしまう。
  //
  // `isRoundTerminated` は `eventEndsAt` 明示が無くても `eventStartsAt + 30 日` で必ず終端を
  // 返す (#1421 liveness invariant) ので、 endsAt を持たない event も有限で止まる。
  // The start checks above plus this shared terminal rule are the isScoringActive gates.
  const drainOnly = isRoundTerminated(item, nowIso);
  const eventStartMs = Date.parse(eventStartsAt);
  if (Number.isNaN(eventStartMs)) return null;
  return {
    tenantId,
    eventId,
    moduleRef: problemId,
    eventStartMs,
    teamId,
    ...(drainOnly ? { drainOnly: true } : {}),
  };
}

/**
 * 収集した target を wire batch に写す。 `eventNowMs = nowMs - eventStartMs` (= event 相対経過、 plugin
 * の tick 契約) を pass の nowMs (= tick 起動時刻、 新たな Date.now() は足さない) から算出する。
 */
export function buildCoordinationTickBatch(
  targets: Iterable<CollectedTickTarget>,
  nowMs: number,
  nowIso: string,
): CoordinationTickBatch {
  return {
    action: COORDINATION_TICK_ACTION,
    nowIso,
    targets: [...targets].map((t) => ({
      tenantId: t.tenantId,
      eventId: t.eventId,
      moduleRef: t.moduleRef,
      eventNowMs: nowMs - t.eventStartMs,
      teamIds: t.teamIds,
      ...(t.drainOnly ? { drainOnly: true } : {}),
    })),
  };
}

/**
 * per-minute pass 用の driver を組む。 scan で集めた event が 1 つ以上あり、 dispatcher function name が
 * 配線されている場合にのみ、 invoker が scope ごとに async Invoke する。対象が 0 / dispatcher 未配線
 * なら invoke しない (= 既存挙動に対し完全な no-op)。 invoke の失敗は握り潰し次 tick に委ねる。
 */
export function createCoordinationTickPass(
  invoke: CoordinationTickInvoker,
  dispatcherFunctionName: string,
  coordinationProblemIds: ReadonlySet<string>,
  repository?: DeploymentsCoordinationPort,
): CoordinationTickPass {
  const targets = new Map<string, CollectedTickTarget>();
  const ended = new Map<string, CollectedTickTarget>();
  return {
    collect: (items, nowIso) =>
      collectCoordinationTickTargets(coordinationProblemIds, items, targets, nowIso, ended),
    run: async (nowMs, nowIso) => {
      if (!dispatcherFunctionName) return;
      // Recovery reads for old events must never delay dispatch of live matches.
      await dispatchTargets([...targets.values()]);
      await dispatchTargets(await pendingEndedTargets(repository, [...ended.values()]));
      async function dispatchTargets(selected: readonly CollectedTickTarget[]) {
        if (!selected.length) return;
        try {
          await invoke(dispatcherFunctionName, buildCoordinationTickBatch(selected, nowMs, nowIso));
        } catch (err) {
          console.warn("[generic-scoring] coordination tick dispatch failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

/** Discovery errors in one ended scope must not suppress ticks for healthy active events. */
async function pendingEndedTargets(
  repository: DeploymentsCoordinationPort | undefined,
  targets: readonly CollectedTickTarget[],
): Promise<CollectedTickTarget[]> {
  if (!repository) return [];
  const pending: CollectedTickTarget[] = [];
  for (let offset = 0; offset < targets.length; offset += 4) {
    const results = await Promise.allSettled(
      targets.slice(offset, offset + 4).map((target) => pendingEndedTarget(repository, target)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[generic-scoring] ended coordination score discovery failed", {
          message: String(result.reason),
        });
        continue;
      }
      if (result.value) pending.push(result.value);
    }
  }
  return pending;
}

async function pendingEndedTarget(
  repository: DeploymentsCoordinationPort,
  target: CollectedTickTarget,
): Promise<CollectedTickTarget | undefined> {
  const key = { tenantId: target.tenantId, eventId: target.eventId, problemId: target.moduleRef };
  const runId = await resolveCurrentCoordinationRunId(repository, key);
  const row = await repository.readCoordinationState({ ...key, runId });
  return row && isCoordinationStateEnvelope(row.state) && row.state.pendingScores
    ? target
    : undefined;
}
