import { runTick } from "@tenkacloud/coordination-plugin-sdk";
import { z } from "zod";
import {
  COORDINATION_TICK_ACTION,
  type CoordinationTickBatch,
  type CoordinationTickTarget,
} from "../shared/coordination-tick-contract.js";
import type { CoordinationConfig } from "./coordination-handler.js";
import { loadCoordinationPlugin, type PluginImporter } from "./coordination-plugin-loader.js";
import { pluginStateSchemaVersion, reconcileStateSchema } from "./coordination-state-schema.js";
import {
  type CoordinationStateScope,
  type CoordinationStoreDeps,
  DEFAULT_COORDINATION_RUN_ID,
  ensureCoordinationMatchSecret,
  readCoordinationState,
  shouldRefreshCoordinationTtl,
  touchCoordinationState,
  writeCoordinationState,
} from "./coordination-store.js";

/**
 * scoring-driven tick Issue #2324: time-driven coordination 遷移 (capture-window クローズ /
 * alliance 失効 等) を **CoordinationDispatcher Lambda 内** で駆動する tick host。
 *
 * 資格情報分離を守るため、 pack-author 由来の plugin の `runTick` 実行は op 経路
 * (`applyOp`) と同じ最小 IAM の dispatcher 内に閉じる (= 採点 Lambda の ssm/kms と同居させない)。
 * dispatcher は既に (a) plugin bundle の importer (materialize) と (b) coordination
 * shared row への Get/Put grant を持つので、 tick はそれらを **そのまま再利用** する (= 追加 IAM ゼロ)。
 *
 * 副作用 (DDB read/write) は {@link CoordinationTickDeps} 越しに注入し、 意味論 (initialState / tick) は
 * 問題同梱 plugin に委譲する。 op 経路 {@link dispatchCoordinationOp} と同じ「read → 純関数 → 楽観 write」
 * 構造で、 write は同一の version 条件付き optimistic write。 変化が無ければ書かない (= WCU 節約)。
 */

/** tick 実行の依存注入 (= plugin importer + shared row store + 宣言 config)。 */
export interface CoordinationTickDeps {
  /** 問題同梱 plugin を動的 import する関数 (= 本番は S3 materialize、 dispatcher が既に持つ seam)。 */
  readonly importer: PluginImporter;
  readonly store: CoordinationStoreDeps;
  /** 宣言 gate: `config[moduleRef]` を持つ問題だけ tick する (= 未宣言 ref を load させない)。 */
  readonly config: CoordinationConfig;
}

/** batch 処理の結果サマリ (= async invoke 応答は捨てられるが、 直接テスト / ログ用に返す)。 */
export interface CoordinationTickBatchResult {
  /** 受理した target 数。 */
  readonly ticked: number;
  /** state が進んで実際に write した数 (= no-op tick は含まない)。 */
  readonly written: number;
}

const TickTargetSchema = z.object({
  tenantId: z.string().min(1),
  eventId: z.string().min(1),
  moduleRef: z.string().min(1),
  eventNowMs: z.number().finite(),
  teamIds: z.array(z.string()).default([]),
});
const TickBatchSchema = z.object({
  action: z.literal(COORDINATION_TICK_ACTION),
  nowIso: z.string().min(1),
  targets: z.array(TickTargetSchema),
});

/**
 * 直接 Invoke の event が tick batch なら parse して返す (= Zod で境界検証)。 HTTP event (= Function URL)
 * や未知形状は `null` を返し、 dispatcher handler が Hono app に委譲する判定に使う。
 */
export function parseCoordinationTickBatch(event: unknown): CoordinationTickBatch | null {
  const parsed = TickBatchSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}

/**
 * batch の各 target を tick する。 1 target の失敗は次 tick で再評価するため握り潰す (= silent に
 * せず warn で可視化)。 return は実 write 数 (= no-op tick は 0)。
 */
export async function handleCoordinationTickBatch(
  deps: CoordinationTickDeps,
  batch: CoordinationTickBatch,
): Promise<CoordinationTickBatchResult> {
  let written = 0;
  for (const target of batch.targets) {
    const didWrite = await tickCoordinationEvent(deps, target, batch.nowIso).catch((err) => {
      console.warn(`[coordination-dispatcher] tick failed event=${target.eventId}`, {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    if (didWrite) written += 1;
  }
  return { ticked: batch.targets.length, written };
}

/**
 * 1 event の tick: 宣言 gate → plugin load → shared row read → `runTick` → 変化時のみ optimistic write。
 * 実際に write したら `true`。 no-op / 未宣言 / load 不可 / conflict は `false` (= 書き込みなし)。
 */
async function tickCoordinationEvent(
  deps: CoordinationTickDeps,
  target: CoordinationTickTarget,
  nowIso: string,
): Promise<boolean> {
  // 宣言 gate: coordination を宣言していない problemId は tick しない (= 未宣言 ref を load させない)。
  if (!deps.config[target.moduleRef]) return false;
  const plugin = await loadCoordinationPlugin(deps.importer, target.moduleRef);
  if (!plugin) {
    // 宣言済だが bundle 不在 / 壊れた plugin。 op 経路の `plugin_unavailable` と同じく副作用に触れず、
    // silent success にせず warn で可視化する (= fail loud、 次 tick で再試行)。
    console.warn(
      `[coordination-dispatcher] plugin unavailable event=${target.eventId} problem=${target.moduleRef}`,
    );
    return false;
  }
  // [Issue #3123] tick も op 経路と同じ namespace を使う。 `moduleRef` は importer の key で
  // あると同時に problemId そのもの (= `coordination/<problemId>.mjs` を引く値、
  // `makeCoordinationScopeResolver` 参照)。 run は platform 既定の 1 run/(event, problem)。
  const scope: CoordinationStateScope = {
    tenantId: target.tenantId,
    eventId: target.eventId,
    problemId: target.moduleRef,
    runId: DEFAULT_COORDINATION_RUN_ID,
  };
  const existing = await readCoordinationState(deps.store, scope);
  // [Issue #3133] tick も `initialState` を呼びうる (= 未初期化 namespace に対する最初の tick)
  // 以上、op 経路とまったく同じ規則で秘密を解決する: 初期化するときだけ、未発行なら発行する。
  //
  // read 専用にして「まだ秘密が無いなら fallback で初期化する」は成立しない。tick が進めた
  // state はそのまま永続化されるので、以後の op は `existing` を見つけて初期化を通らず、
  // 試合まるごとが fallback seed のまま進んでしまう (= この issue が閉じたい穴が tick 経由で
  // 開いたままになる)。state が既にあるときは秘密に触れないのは op 経路と同じ。
  let currentState: unknown;
  let version: number;
  if (existing) {
    // [Issue #3150] op 経路 (`dispatchCoordinationOp`) と同じ突き合わせ。 mismatch は state を
    // 一切進めず、 TTL だけ延ばして試合を消さない (= write が要らないので version 条件も張らない)。
    const reconciled = reconcileStateSchema(plugin, existing);
    if (reconciled.kind === "mismatch") {
      console.warn(
        `[coordination-dispatcher] tick schema mismatch event=${target.eventId} problem=${target.moduleRef} reason=${reconciled.reason}` +
          (reconciled.detail ? ` detail=${JSON.stringify(reconciled.detail)}` : ""),
      );
      await refreshCoordinationTtl(deps, target, scope, existing, nowIso);
      return false;
    }
    currentState = reconciled.state;
    version = existing.version;
  } else {
    currentState = plugin.initialState({
      eventId: target.eventId,
      teamIds: [...target.teamIds],
      matchSecret: await ensureCoordinationMatchSecret(deps.store, scope, nowIso),
    });
    version = 0;
  }
  // eventNowMs は採点 pass が算出した event 相対経過 (= plugin の tick 契約、 参照 Battle は
  // CAPTURE_WINDOW_MS と比較)。 dispatcher は clock を持たず、 渡された値だけで純関数を回す。
  const nextState = runTick(plugin, currentState, target.eventNowMs);
  if (!coordinationStateChanged(currentState, nextState)) {
    // [Issue #3150] migration だけが起きて tick 自体は no-op だった行はここに来る。 write が無い
    // ので封筒は書き換わらず、 行は旧版のまま残る (= lazy upgrade。 migration は次に呼ばれるときも
    // 冪等に走るので害はない)。 TTL の延長だけは行う -- 試合を消さないのはここでも同じ。
    await refreshCoordinationTtl(deps, target, scope, existing, nowIso);
    return false;
  }
  const written = await writeCoordinationState(
    deps.store,
    scope,
    nextState,
    version,
    nowIso,
    pluginStateSchemaVersion(plugin),
  );
  if (written.kind === "conflict") {
    // 並行 op が version race に勝った (= applyOp が先に書いた)。 lost-update を作らず次 tick で
    // 最新 state を再読込して再評価する (= op 経路と同じ optimistic-lock 契約)。
    console.warn(`[coordination-dispatcher] tick write conflict event=${target.eventId}`);
    return false;
  }
  if (written.kind === "too_large") {
    // [Issue #3151] The tick is where an over-budget match was always going to
    // be discovered first: it runs every minute whether or not participants are
    // acting. There is nothing to retry -- the state does not shrink by being
    // written again -- so the tick reports it and moves on to the other
    // namespaces in this batch. The store has already emitted the operator
    // warning; taking down the whole scoring pass for one full match would turn
    // one stopped game into an outage for every other event.
    console.warn(
      `[coordination-dispatcher] tick write refused (state over budget) event=${target.eventId} ` +
        `problem=${target.moduleRef} bytes=${written.bytes ?? "unmeasurable"} ` +
        `max=${written.budget.maxBytes} backend=${written.budget.backend}`,
    );
    // TTL は延ばす。 書けないことと「試合が終わった」ことは別で、 ここで retention の時計を
    // 進ませると、 運営が対処する前に行そのものが消える。
    await refreshCoordinationTtl(deps, target, scope, existing, nowIso);
    return false;
  }
  return true;
}

/**
 * [Issue #3123] Push a namespace's TTL out on a tick that changed nothing.
 *
 * The tick is the platform's liveness signal for a namespace: it runs for every
 * coordination problem in a started event, whether or not the plugin implements
 * `tick`, and stops when the event does. Refreshing here is what anchors
 * retention to the EVENT going quiet instead of the participants going quiet --
 * without it, a plugin with no `tick` hook (`microservice-migration-battle`'s
 * `router.ts` is one) would let its state age out mid-match and the next
 * request would silently rebuild from `initialState`.
 *
 * Only past the halfway mark, so this costs one write per namespace per
 * half-window rather than one per minute. A namespace with no row has nothing
 * to keep alive, and a failure is warned rather than thrown: a missed refresh
 * still leaves half the window of margin, and failing here would turn a
 * cosmetic write failure into a scoring outage for the rest of the batch.
 */
async function refreshCoordinationTtl(
  deps: CoordinationTickDeps,
  target: CoordinationTickTarget,
  scope: CoordinationStateScope,
  existing: { readonly expiresAt?: number } | undefined,
  nowIso: string,
): Promise<void> {
  if (!existing) return;
  if (!shouldRefreshCoordinationTtl(existing.expiresAt, Date.parse(nowIso))) return;
  try {
    await touchCoordinationState(deps.store, scope, nowIso);
  } catch (err) {
    console.warn(
      `[coordination-dispatcher] ttl refresh failed event=${target.eventId} problem=${target.moduleRef}`,
      { message: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * tick 前後の state が実質変わったか。 `runTick` は no-op 時に同一参照を返す契約なので、 まず参照で
 * 弾き (= 最頻ケースを 0 コスト)、 万一 clone を返す plugin 向けに JSON 構造比較で fallback する。
 */
export function coordinationStateChanged(prev: unknown, next: unknown): boolean {
  if (prev === next) return false;
  return JSON.stringify(prev) !== JSON.stringify(next);
}
