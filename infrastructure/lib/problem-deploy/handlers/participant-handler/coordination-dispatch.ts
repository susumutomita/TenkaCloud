import {
  type CoordinationContext,
  type CoordinationPlugin,
  dispatchOp,
  safeProjectForTeam,
} from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import {
  type CoordinationStoreDeps,
  readCoordinationState,
  writeCoordinationState,
} from "./coordination-store.js";

/**
 * Issue #1420: platform-side coordination dispatcher の純粋なオーケストレーション。
 *
 * 副作用 (DDB read/write) は {@link CoordinationStoreDeps} 越しに注入し、 意味論 (validate / apply /
 * project) は問題が同梱する {@link CoordinationPlugin} に委譲する。 platform は SDK の純 util
 * (`dispatchOp` / `safeProjectForTeam`) を「DDB から read → dispatch → 楽観ロック write」 の外側で
 * 呼ぶだけで、 問題依存の意味論を一切持たない (problem=plugin / platform=host)。
 */

/** dispatch 1 回の文脈。 route が team-login-key 認証 + event scope を解決して渡す。 */
export interface CoordinationDispatchInput<Op> {
  /**
   * [Issue #3123] 永続化 namespace (tenant x event x problem x run)。 platform が所有し、
   * plugin へは渡さない。 4 つの同型 string を個別引数で運ぶと取り違えが型検査を通ってしまうため、
   * store まで 1 つの object のまま持ち回る。
   */
  readonly scope: CoordinationStateScope;
  readonly teamId: string;
  readonly op: Op;
  /** plugin が初期化に使う event 文脈 (= 参加チーム一覧)。 */
  readonly ctx: CoordinationContext;
  /** projection が失敗 / 未初期化のときに返す安全な既定値 (= 機密を出さない)。 */
  readonly fallbackProjection: unknown;
  readonly nowIso: string;
}

export type CoordinationDispatchOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" };

/** ctx.eventId が永続化 key (eventId) と一致し、 認証 team が ctx.teamIds に含まれるか。 */
function isContextConsistent(input: {
  readonly scope: CoordinationStateScope;
  readonly teamId: string;
  readonly ctx: CoordinationContext;
}): boolean {
  return input.ctx.eventId === input.scope.eventId && input.ctx.teamIds.includes(input.teamId);
}

/**
 * op を受理 → 適用 → 永続化し、 当該 team 向け projection を返す。
 *   1. 現在 state を読む (無ければ plugin.initialState で初期化、 version 0)
 *   2. SDK `dispatchOp` で validate→apply (拒否なら `rejected`)
 *   3. version 条件付き write (並行更新なら `conflict` → caller が 409 で退避)
 *   4. `safeProjectForTeam` で fail-safe に projection を返す
 */
export async function dispatchCoordinationOp<State, Op, Projection>(
  store: CoordinationStoreDeps,
  plugin: CoordinationPlugin<State, Op, Projection>,
  input: CoordinationDispatchInput<Op>,
): Promise<CoordinationDispatchOutcome> {
  // ctx (= 初期化に使う event 文脈) が永続化 key (eventId) / 認証 team とズレていたら、
  // 別 event 用に組んだ state を保存 / 配信してしまう。 read/write 前に fail-closed で弾く。
  if (!isContextConsistent(input)) return { kind: "rejected", error: "context_mismatch" };

  const existing = await readCoordinationState(store, input.scope);
  const state = (existing?.state as State) ?? plugin.initialState(input.ctx);
  const version = existing?.version ?? 0;

  const verdict = dispatchOp(plugin, state, input.teamId, input.op);
  if (!verdict.ok) return { kind: "rejected", error: verdict.error };

  const written = await writeCoordinationState(
    store,
    input.scope,
    verdict.state,
    version,
    input.nowIso,
  );
  if (written.kind === "conflict") return { kind: "conflict" };

  const projection = safeProjectForTeam(
    plugin,
    verdict.state,
    input.teamId,
    input.fallbackProjection as Projection,
  );
  return { kind: "ok", projection };
}

/**
 * 当該 team の現在 projection を読む (= 書き込みなし、 portal の polling 用)。 state 未初期化なら
 * plugin.initialState を投影する。 plugin が throw しても `fallbackProjection` を返す (fail-safe)。
 */
export async function projectCoordinationForTeam<State, Op, Projection>(
  store: CoordinationStoreDeps,
  plugin: CoordinationPlugin<State, Op, Projection>,
  input: {
    readonly scope: CoordinationStateScope;
    readonly teamId: string;
    readonly ctx: CoordinationContext;
    readonly fallbackProjection: unknown;
  },
): Promise<unknown> {
  // ctx 不整合 (= 別 event 用 ctx / team が event 外) は fail-closed で fallback を返す (= 機密非漏洩)。
  if (!isContextConsistent(input)) return input.fallbackProjection;
  const existing = await readCoordinationState(store, input.scope);
  const state = (existing?.state as State) ?? plugin.initialState(input.ctx);
  return safeProjectForTeam(plugin, state, input.teamId, input.fallbackProjection as Projection);
}
