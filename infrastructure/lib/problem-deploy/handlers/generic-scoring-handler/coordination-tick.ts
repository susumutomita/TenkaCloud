import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  COORDINATION_TICK_ACTION,
  type CoordinationTickBatch,
} from "../shared/coordination-tick-contract.js";
import type { CoordinationTickInvoker } from "./coordination-tick-dispatch.js";

/**
 * scoring-driven tick (#2324) の **採点 pass 側**。 coordination を宣言した event を per-minute
 * pass で見つけ、 tick 対象を batch にまとめて CoordinationDispatcher Lambda を 1 回 async Invoke する。
 *
 * 資格情報分離: 採点 Lambda は ssm:GetParameter / kms:Decrypt を持つため、 pack-author
 * 由来の plugin を **ここでは load / 実行しない**。 「どの event が coordination を宣言しているか」だけを
 * `PROBLEM_COORDINATION` config (= problemId 集合、 plugin code ではない純 metadata) で判定し、 実 tick
 * (plugin の runTick) は最小 IAM の dispatcher に委ねる (= op 経路と同じ場所)。 event 数によらず invoke は
 * 1 回/分。 coordination event が 0 なら invoke しない (= 既存挙動に対し完全な no-op)。
 */

/** scan で集めた 1 event 分の tick 対象 (= wire 送出前の内部形。 eventNowMs は送出時に算出)。 */
export interface CollectedTickTarget {
  readonly tenantId: string;
  readonly eventId: string;
  readonly moduleRef: string;
  /** event 開始時刻 (epoch ms)。 送出時に `eventNowMs = nowMs - eventStartMs` へ変換する。 */
  readonly eventStartMs: number;
  readonly teamIds: string[];
}

/** per-minute pass に差し込む driver (= scan で集めて、 scan 後に dispatcher を 1 回 invoke する)。 */
export interface CoordinationTickPass {
  /** scan 1 ページから tick 対象を集約する (= per-page で呼ぶ)。 */
  collect(items: readonly Partial<DeploymentItem>[], nowIso: string): void;
  /** 集めた対象を batch にして dispatcher を 1 回 async Invoke する (= scan 後に 1 回)。 */
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
 * scan 1 ページの deployment 群から tick 対象を event 単位で収集する (= 集約)。 coordination を宣言した
 * 問題の COMPLETE deployment を `${tenantId}#${eventId}` で dedupe し、 未開始 event (= `eventStartsAt`
 * 不在 / 未来) は `isScoringActive` と同じ start gate で除外する。
 */
export function collectCoordinationTickTargets(
  coordinationProblemIds: ReadonlySet<string>,
  items: readonly Partial<DeploymentItem>[],
  out: Map<string, CollectedTickTarget>,
  nowIso: string,
): void {
  if (coordinationProblemIds.size === 0) return;
  for (const item of items) {
    const candidate = toTickCandidate(coordinationProblemIds, item, nowIso);
    if (!candidate) continue;
    const key = `${candidate.tenantId}#${candidate.eventId}`;
    const existing = out.get(key);
    if (existing) {
      if (!existing.teamIds.includes(candidate.teamId)) existing.teamIds.push(candidate.teamId);
      continue;
    }
    out.set(key, {
      tenantId: candidate.tenantId,
      eventId: candidate.eventId,
      moduleRef: candidate.moduleRef,
      eventStartMs: candidate.eventStartMs,
      teamIds: [candidate.teamId],
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
}
function toTickCandidate(
  coordinationProblemIds: ReadonlySet<string>,
  item: Partial<DeploymentItem>,
  nowIso: string,
): TickCandidate | null {
  const { tenantId, eventId, problemId, teamId, eventStartsAt } = item;
  if (!tenantId || !eventId || !problemId || !teamId) return null;
  if (!coordinationProblemIds.has(problemId)) return null;
  // start gate: eventStartsAt 不在 / 未来なら tick しない (= 未開始 event の early-lock 防止)。
  if (typeof eventStartsAt !== "string" || nowIso < eventStartsAt) return null;
  const eventStartMs = Date.parse(eventStartsAt);
  if (Number.isNaN(eventStartMs)) return null;
  return { tenantId, eventId, moduleRef: problemId, eventStartMs, teamId };
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
    })),
  };
}

/**
 * per-minute pass 用の driver を組む。 scan で集めた event が 1 つ以上あり、 dispatcher function name が
 * 配線されている場合にのみ、 batch を 1 回 async Invoke する。 coordination event が 0 / dispatcher 未配線
 * なら invoke しない (= 既存挙動に対し完全な no-op)。 invoke の失敗は握り潰し次 tick に委ねる。
 */
export function createCoordinationTickPass(
  invoke: CoordinationTickInvoker,
  dispatcherFunctionName: string,
  coordinationProblemIds: ReadonlySet<string>,
): CoordinationTickPass {
  const targets = new Map<string, CollectedTickTarget>();
  return {
    collect: (items, nowIso) =>
      collectCoordinationTickTargets(coordinationProblemIds, items, targets, nowIso),
    run: async (nowMs, nowIso) => {
      if (targets.size === 0 || !dispatcherFunctionName) return;
      const batch = buildCoordinationTickBatch(targets.values(), nowMs, nowIso);
      try {
        await invoke(dispatcherFunctionName, batch);
      } catch (err) {
        // dispatcher invoke 失敗 (= throttle / not found 等) は次 tick に委ねる (= 採点を巻き込まない)。
        console.warn("[generic-scoring] coordination tick dispatch failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
