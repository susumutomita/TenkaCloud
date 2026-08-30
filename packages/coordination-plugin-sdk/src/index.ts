/**
 * @tenkacloud/coordination-plugin-sdk — inter-team coordination plugin の public API。
 *
 * Battle の「参加者間 interaction」 (router / 同盟 / 共有資源 queue 等) は問題ごとに意味が違うため、
 * platform に hardcode せず、**問題が state machine を同梱して差し替える** plugin 方式にする。
 * 問題を plugin、platform を host とし、問題は
 * `problems/<id>/coordination/<name>.ts` で `CoordinationPlugin` を default export し、 platform の
 * dispatcher Lambda (= 本 SDK の純 reducer を実行) が tenant/event 単位の 1 row state を駆動する。
 *
 * 本パッケージは **型 + 純 util だけ** を提供する (React / AWS SDK 非依存。 portal-plugin-sdk と
 * 同形)。実際の DDB 永続化と cross-account 配送は platform 側の infrastructure が所有する。
 *
 * The reference Battle is
 * `packs/reference-coordination-battle`。public API の変更時は本 SDK の version も更新する。
 */

/**
 * event 開始時に `initialState` へ渡る文脈。
 *
 * `eventId` / `teamIds` は routing key であって秘密ではない — URL・log・portal の
 * props に載る。 隠し材料をこれらから導出してはいけない ({@link CoordinationContext.matchSecret}
 * を使う)。
 */
export interface CoordinationContext {
  readonly eventId: string;
  /** 参加チームの teamId 一覧 (= 初期 state を teams 数に応じて組むため)。 */
  readonly teamIds: readonly string[];
  /**
   * [Issue #3133] この試合だけの server-only 秘密 (高エントロピー hex)。
   *
   * 参加者に推測できない材料が要る plugin (秘密の生成、 share の分割、 FHE / MPC の
   * 入力導出) はこれを seed にする。 platform が試合ごとに生成して plugin から見えない
   * 場所に保存し、 participant-facing な応答には決して載せない。
   *
   * **`eventId` を seed にしてはいけない。** 問題 repository は public なので導出関数は
   * 全て公開されており、 portal は同じ `eventId` を参加者のブラウザへ渡す。 つまり
   * `eventId` を seed にした瞬間、 隠したはずの材料は誰でも再計算できる。
   *
   * optional な理由は 2 つあり、 どちらも「まだ platform が発行していない」状態を表す:
   *   - state の row がまだ無い read 専用経路 (portal の polling が最初の op より先に来た
   *     場合)。 次の op が row と一緒に秘密を発行する。
   *   - platform を通さない local play / 単体テスト。
   *
   * したがって plugin は不在時の fallback を持つ必要がある。 ただし fallback に
   * `ctx.eventId` を選ぶと上記の理由でそれは秘密ではない。
   */
  readonly matchSecret?: string;
}

/** operation の受理可否。 不可のとき error は機械可読な短い理由コード。 */
export type ValidateResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * 問題が default export する coordination state machine。
 *
 * - `State` は plugin 固有の共有状態 (= 1 event 1 row、 N teams で共有)。
 * - `Op` は team が送る operation (= cast-event payload)。
 * - `Projection` は各 team の portal に返す投影 (= 他 team の機密を漏らさない)。
 *
 * 全 hook は **副作用なしの純関数**。 platform はこれらを呼ぶだけで、 問題依存の意味論を知らない。
 */
export interface CoordinationPlugin<State, Op, Projection = unknown> {
  /** event 開始時の初期 state。 */
  initialState(ctx: CoordinationContext): State;
  /** operation を受理可能か判定 (= rate limit / 入力検証 / phase 制約)。 */
  validateOp(state: State, teamId: string, op: Op): ValidateResult;
  /** state を変える純関数 (= 副作用なし)。 validateOp が ok のときだけ呼ばれる。 */
  applyOp(state: State, teamId: string, op: Op): State;
  /** scoring engine が tick ごとに呼ぶ optional hook (= 経過時間で alliance 解消等)。 */
  tick?(state: State, eventNowMs: number): State;
  /** その team の portal に渡す projection (= 他 team の機密を漏らさない投影)。 */
  projectForTeam(state: State, teamId: string): Projection;
}

/** {@link dispatchOp} の結果。 受理時は次 state、 拒否時は validateOp の error。 */
export type DispatchResult<State> =
  | { readonly ok: true; readonly state: State }
  | { readonly ok: false; readonly error: string };

/**
 * dispatcher の純 core: validate → (ok なら) apply。 validateOp が拒否したら state は不変。
 * platform の dispatcher Lambda はこの純関数を「DDB から read → dispatchOp → ok なら
 * optimistic-lock write」 の中で使う (= 副作用は platform 側、 意味論は plugin 側)。
 */
export function dispatchOp<State, Op>(
  plugin: CoordinationPlugin<State, Op>,
  state: State,
  teamId: string,
  op: Op,
): DispatchResult<State> {
  const verdict = plugin.validateOp(state, teamId, op);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  return { ok: true, state: plugin.applyOp(state, teamId, op) };
}

/** tick hook を持つ plugin だけ state を進める。 未定義なら state をそのまま返す (= no-op)。 */
export function runTick<State, Op>(
  plugin: CoordinationPlugin<State, Op>,
  state: State,
  eventNowMs: number,
): State {
  return plugin.tick ? plugin.tick(state, eventNowMs) : state;
}

/**
 * 問題が default export する plugin を **型推論付き** で書くための identity helper。
 * `export default defineCoordinationPlugin({ ... })` とすると、 各 hook の State / Op / Projection が
 * 相互推論される (= 問題 author が型注釈を手書きせずに contract へ従える。 defineConfig 同形)。
 * 実体は引数をそのまま返すだけ。参照 Battle 問題はこれ経由で書く。
 */
export function defineCoordinationPlugin<State, Op, Projection = unknown>(
  plugin: CoordinationPlugin<State, Op, Projection>,
): CoordinationPlugin<State, Op, Projection> {
  return plugin;
}

/**
 * {@link CoordinationPlugin.projectForTeam} を **fail-safe** に包む。 plugin (= 問題が同梱) が
 * throw しても portal を壊さず `fallback` を返す。 これにより buggy / 未対応な問題でも参加者画面が
 * 落ちない (opt-in しない問題は安全に no-op となる)。機密の非漏洩は
 * 呼び出し側が「空 / 当たり障りのない」 fallback を渡すことで担保する (= 他 team state を出さない)。
 */
export function safeProjectForTeam<State, Op, Projection>(
  plugin: CoordinationPlugin<State, Op, Projection>,
  state: State,
  teamId: string,
  fallback: Projection,
): Projection {
  try {
    return plugin.projectForTeam(state, teamId);
  } catch {
    return fallback;
  }
}
