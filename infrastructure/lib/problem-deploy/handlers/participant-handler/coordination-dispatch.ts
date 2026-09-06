import { randomInt } from "node:crypto";
import {
  type CoordinationContext,
  type CoordinationPlugin,
  dispatchOp,
  safeProjectForTeam,
} from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateBudget } from "../../control-data/domain/coordination-budget.js";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import {
  COORDINATION_SCORE_DELIVERY_BUDGET_MS,
  coordinationScoreDelivery,
  deliverCoordinationScores,
  tryDeliverCoordinationScores,
} from "./coordination-scoring.js";
import {
  pluginStateSchemaVersion,
  reconcileStateSchema,
  type StateSchemaMismatchReason,
} from "./coordination-state-schema.js";
import {
  type CoordinationStoreDeps,
  ensureCoordinationMatchSecret,
  readCoordinationMatchSecret,
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
  | {
      readonly kind: "ok";
      readonly projection: unknown;
    }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" }
  /**
   * [Issue #3151] The op was valid and applied, but the resulting state does
   * not fit the selected backend's size budget, so the platform refused to
   * persist it. Nothing was written; the match is where it was before this op.
   *
   * Deliberately not `rejected`: `rejected` is the plugin's verdict on the
   * participant's move and its `error` is the plugin's own vocabulary. This is
   * the platform saying the backend has no room, which is not the
   * participant's mistake and not something a different move would fix.
   */
  | {
      readonly kind: "too_large";
      readonly bytes?: number;
      readonly budget: CoordinationStateBudget;
    }
  /**
   * [Issue #3150] The persisted row's `stateSchemaVersion` could not be
   * reconciled against the plugin currently loaded. Neither the row nor the
   * write-side of this dispatch is touched -- see `coordination-state-schema.ts`
   * for what each reason means and why this outcome never falls back to
   * `initialState`.
   */
  | {
      readonly kind: "schema_mismatch";
      readonly reason: StateSchemaMismatchReason;
      /** `migration_failed` の throw メッセージ。 ログ専用で HTTP 応答には載せない。 */
      readonly detail?: string;
    };

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
 *   1.5. [Issue #3150] 既存 state があれば `reconcileStateSchema` で突き合わせる。
 *        mismatch ならここで打ち切り (`schema_mismatch`) — 以降の 2〜4 には進まない
 *   2. SDK `dispatchOp` で validate→apply (拒否なら `rejected`)
 *   3. version 条件付き write (並行更新なら 1 から読み直して再試行。 上限回数まで負けたら
 *      `conflict` を返し、 caller が 409 で退避。 write は常に plugin の現在の版で封筒に刻む)
 *   4. `safeProjectForTeam` で fail-safe に projection を返す
 *
 * [Issue #3164] 3 の再試行がここに居るのは、 この関数だけが read と validate の両方を持って
 * いるから。 呼び出し側が 409 を受けて投げ直すと、 参加者から見れば「押したのに消えた手」に
 * なる (portal は conflict を汎用のインフラ エラーとして出す)。 1 試合 1 行を全 op が書き換える
 * 設計では、 チーム数が増えるほどこれは日常的に起きる。
 */
export async function dispatchCoordinationOp<State, Op, Projection>(
  store: CoordinationStoreDeps,
  plugin: CoordinationPlugin<State, Op, Projection>,
  input: CoordinationDispatchInput<Op>,
  options: CoordinationDispatchOptions<State> = {},
): Promise<CoordinationDispatchOutcome> {
  // ctx (= 初期化に使う event 文脈) が永続化 key (eventId) / 認証 team とズレていたら、
  // 別 event 用に組んだ state を保存 / 配信してしまう。 read/write 前に fail-closed で弾く。
  // Checked once rather than per attempt: it reads only the request, which no
  // retry can change.
  if (!isContextConsistent(input)) return { kind: "rejected", error: "context_mismatch" };

  const scoreDeadlineMs = Date.now() + COORDINATION_SCORE_DELIVERY_BUDGET_MS;
  const attempts = options.attempts ?? DEFAULT_WRITE_ATTEMPTS;
  const backoff = options.backoff ?? jitteredBackoff;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await attemptDispatch(
      store,
      plugin,
      input,
      options.schema ?? plugin,
      scoreDeadlineMs,
    );
    if (outcome.kind !== "conflict") return outcome;
    if (attempt + 1 >= attempts) return outcome;
    await backoff(attempt);
  }
}

/**
 * [Issue #3164] How many times one participant action may try to land.
 *
 * The whole match is one row, rewritten under a version condition on every op,
 * and Orders arrive for every team at the same instant — so at twenty teams a
 * batch is 120–400 writes inside a five-minute window against a single key.
 * With a 334 KB row and no retry, a double-digit share of moves came back as
 * `conflict`, which the portal shows as a generic infrastructure error with the
 * move discarded. At two teams the same arithmetic gives a couple of percent,
 * which is why it went unseen.
 *
 * Five attempts, not unlimited: the participant is waiting on this HTTP
 * response, and a retry that never gives up turns contention into a queue that
 * outlives the Lambda. Five with the backoff below is a few hundred
 * milliseconds in the bad case.
 */
const DEFAULT_WRITE_ATTEMPTS = 5;

/** Injectable so tests do not sleep, and so the delays can be observed. */
/**
 * [Issue #3150] load 時に検証した版宣言。 plugin から読み直さずこれを使う。
 *
 * Codex review: `stateSchemaVersion` が可変 state に裏打ちされた accessor だと、 検証時に 1 を
 * 返して通り、 DDB の await を挟んだ再読で別の値を返しうる。 そうなると突き合わせや write が
 * `invalid_schema` ではなく throw になり、 tick は外側の catch に飛んで TTL 延長を飛ばす --
 * 進行中の行を retention で失う、 この gate が塞ごうとしている失敗そのもの。 retry が入った今は
 * 試行ごとに読み直す機会が増えるので、 なおさら固定した値を配る。
 *
 * plugin を包む形 (`Object.create`) では直せない: hook の `this` が wrapper になり、
 * `#private` を持つ class instance の plugin が壊れる。 だから包まず、 **検証した値だけを
 * 別に持ち回る**。
 */
export type CoordinationSchemaDeclaration<State = unknown> = Pick<
  CoordinationPlugin<State, unknown>,
  "stateSchemaVersion" | "migrateState"
>;

export interface CoordinationDispatchOptions<State = unknown> {
  readonly attempts?: number;
  readonly backoff?: (attempt: number) => Promise<void>;
  /**
   * [Issue #3150] load 時に検証した版宣言。 省略時は plugin 自身 (= 直呼びする test と、
   * この Issue 以前の意味論)。 本番経路は必ず loader が snapshot を渡す。
   */
  readonly schema?: CoordinationSchemaDeclaration<State>;
}

/**
 * The widest wait a given retry may draw, doubling each time: 25, 50, 100, 200 ms.
 *
 * Exported because the doubling is the property worth pinning, and pinning it
 * through the jitter would mean asserting on a random draw.
 */
export function backoffCeilingMs(attempt: number): number {
  return 25 * 2 ** attempt;
}

/**
 * Exponential backoff with FULL jitter, because the losers of one collision are
 * otherwise released together.
 *
 * Twenty teams retrying on the same fixed delay collide again as a group, which
 * turns one contended moment into a standing wave. Drawing a fresh value inside
 * the window spreads them across it instead.
 *
 * `randomInt` rather than `Math.random` — not because jitter needs an
 * unpredictable source, but because the linter cannot tell this call apart from
 * one that does, and a CSPRNG drawn at most four times per contended op costs
 * nothing worth measuring. The alternative was suppressing the rule here, which
 * would also suppress it for whatever this function grows into.
 */
async function jitteredBackoff(attempt: number): Promise<void> {
  const ceiling = backoffCeilingMs(attempt);
  await new Promise((resolve) => setTimeout(resolve, randomInt(0, ceiling + 1)));
}

/**
 * One read → validate → apply → conditional-write cycle.
 *
 * The read is INSIDE this function, so a retry re-reads and then re-runs
 * `validateOp` against what it read. That is the point of retrying here rather
 * than re-writing the state we already computed: between the two attempts
 * another team may have hunted this team's secret, the Order may have expired,
 * or the match may have ended, and each of those must come back as `rejected`
 * on its own merits. Replaying the first attempt's result would apply a move
 * the rules no longer allow.
 */
async function attemptDispatch<State, Op, Projection>(
  store: CoordinationStoreDeps,
  plugin: CoordinationPlugin<State, Op, Projection>,
  input: CoordinationDispatchInput<Op>,
  schema: CoordinationSchemaDeclaration<State>,
  scoreDeadlineMs: number,
): Promise<CoordinationDispatchOutcome> {
  const existing = await readCoordinationState(store, input.scope);
  if (
    !(await deliverCoordinationScores(store, input.scope, existing, {
      deadlineMs: scoreDeadlineMs,
    }))
  )
    return { kind: "unavailable" };
  // [Issue #3133] 秘密が要るのは `initialState` を呼ぶときだけ — ctx を受け取る hook は
  // それ 1 つで、 validateOp / applyOp / projectForTeam は (state, teamId, op) しか見ない。
  // だから既存 state があるときは秘密に一切触らない: 全 op に read/write を足さずに済む。
  let state: State;
  let version: number;
  if (existing) {
    // [Issue #3150] 既存の行がある分岐の直後で突き合わせる。 mismatch はここで打ち切り —
    // initialState を呼ばず、 write もしない (= 静かに壊れる代わりに、 その op だけを安全に止める)。
    const reconciled = reconcileStateSchema<State>(schema, existing);
    if (reconciled.kind === "mismatch") {
      return { kind: "schema_mismatch", reason: reconciled.reason, detail: reconciled.detail };
    }
    state = reconciled.state;
    version = existing.version;
  } else {
    state = plugin.initialState(await withMatchSecret(store, input.scope, input.ctx, input.nowIso));
    version = 0;
  }

  const verdict = dispatchOp(plugin, state, input.teamId, input.op);
  if (!verdict.ok) return { kind: "rejected", error: verdict.error };

  const pendingScores = coordinationScoreDelivery(
    plugin,
    state,
    verdict.state,
    { kind: "op", teamId: input.teamId, op: input.op },
    input.nowIso,
  );
  const written = await writeCoordinationState(
    store,
    input.scope,
    verdict.state,
    version,
    input.nowIso,
    // [Issue #3150] write は常に plugin の「現在の」版で封筒に刻む -- migrated 経路 (旧行を
    // 持ち上げた) でも、 未初期化からの初回 write でも同じ。 旧版のまま書く理由が無い。
    pluginStateSchemaVersion(schema),
    pendingScores,
  );
  if (written.kind === "conflict") return { kind: "conflict" };
  if (written.kind === "too_large") {
    return { kind: "too_large", bytes: written.bytes, budget: written.budget };
  }

  const projection = safeProjectForTeam(
    plugin,
    verdict.state,
    input.teamId,
    input.fallbackProjection as Projection,
  );
  await tryDeliverCoordinationScores(
    store,
    input.scope,
    {
      state: verdict.state,
      version: version + 1,
      pendingScores,
    },
    { deadlineMs: scoreDeadlineMs },
  );
  return { kind: "ok", projection };
}

/** {@link projectCoordinationForTeam} の結果。 */
export type CoordinationProjectionOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  /**
   * [Issue #3150] projection は participant portal がいちばんポーリングする経路。
   * mismatch を fallback で飲み込んで 200 を返すと、 空の板が正常応答のふりをして返る --
   * この Issue が最も嫌う「静かに壊れる」そのもの。 だから read 経路でも op 経路と同じ
   * outcome を返し、 caller (handler) が 503 に写す。
   */
  | {
      readonly kind: "schema_mismatch";
      readonly reason: StateSchemaMismatchReason;
      readonly detail?: string;
    };

/**
 * 当該 team の現在 projection を読む。未配信の採点は再試行するが、試合状態は進めない。 state 未初期化なら
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
  schema: CoordinationSchemaDeclaration<State> = plugin,
): Promise<CoordinationProjectionOutcome> {
  // ctx 不整合 (= 別 event 用 ctx / team が event 外) は fail-closed で fallback を返す (= 機密非漏洩)。
  if (!isContextConsistent(input)) return { kind: "ok", projection: input.fallbackProjection };
  const existing = await readCoordinationState(store, input.scope);
  // Recovery must remain possible after the event window closes and scheduled ticks stop.
  // This only delivers an already committed transition; it does not advance the game or TTL.
  if (existing?.pendingScores) await tryDeliverCoordinationScores(store, input.scope, existing);
  if (existing) {
    // [Issue #3150] read 経路なので write はしない -- mismatch はそのまま返し、 ok (migrated
    // でも) はその state を投影するだけで版を書き戻さない。
    const reconciled = reconcileStateSchema<State>(schema, existing);
    if (reconciled.kind === "mismatch") {
      return { kind: "schema_mismatch", reason: reconciled.reason, detail: reconciled.detail };
    }
    return {
      kind: "ok",
      projection: safeProjectForTeam(
        plugin,
        reconciled.state,
        input.teamId,
        input.fallbackProjection as Projection,
      ),
    };
  }
  // [Issue #3133] 未初期化 state の投影。 read 経路なので秘密は **発行しない** — GET が
  // 書き込みになるし、 始まらないかもしれない試合に秘密を配ることになる。 既に op が
  // 走っていれば発行済みの値が読めるので、 その試合の projection は op 経路と一致する。
  const matchSecret = await readCoordinationMatchSecret(store, input.scope);
  const ctx: CoordinationContext = matchSecret ? { ...input.ctx, matchSecret } : input.ctx;
  return {
    kind: "ok",
    projection: safeProjectForTeam(
      plugin,
      plugin.initialState(ctx),
      input.teamId,
      input.fallbackProjection as Projection,
    ),
  };
}

/**
 * [Issue #3133] `initialState` に渡す ctx へ、 この試合の server-only 秘密を足す。
 *
 * write 経路専用 — 未発行なら発行する。 呼ばれるのは state を初期化する瞬間だけなので、
 * 試合が始まったあとの op はこの経路を通らない。 op が validateOp で弾かれても発行済みの
 * 秘密は残るが、 それは孤児ではなく「この試合の秘密」で、 次に成功する op がそのまま採用する。
 */
async function withMatchSecret(
  store: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  ctx: CoordinationContext,
  nowIso: string,
): Promise<CoordinationContext> {
  return { ...ctx, matchSecret: await ensureCoordinationMatchSecret(store, scope, nowIso) };
}
