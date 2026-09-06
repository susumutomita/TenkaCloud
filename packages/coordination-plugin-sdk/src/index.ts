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
   * [Issue #3172] teamId → 参加者に見せる表示名。
   *
   * teamId は ULID なので、 plugin が相手チームを画面に出すと
   * `01M1J5VK3N6KX5G3MYW190S9Q8` がそのまま並ぶ。 表示名は roster (deployment 行の
   * `displayTeamName ?? teamName`) が持っており、 plugin からは引けない。
   *
   * optional なのは、 platform を通さない local play / 単体テストのため。 名前が無い
   * teamId は plugin 側で id へ fallback する。
   *
   * **既知の限界**: ctx を受け取る hook は `initialState` だけなので、 試合開始後の
   * 改名は反映されない。 反映するには SDK が別 hook にも ctx を渡す必要がある。
   */
  readonly teamNames?: Readonly<Record<string, string>>;
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
  /**
   * [Issue #3150] この plugin が読み書きする state の schema 版。省略時は 1 とみなす。正の整数。
   *
   * 永続化された行にはこの値が platform によって刻まれ (`coordination-store.ts` の envelope)、
   * 次に読むときに突き合わされる。 **State の形を変えたら必ずこの値を上げる** — platform は
   * 「plugin コードの形」と「行に刻まれた版」が食い違っていることしか検出できず、
   * 上げ忘れ (= 形は変わったのに版が同じ) は検出できない。 その場合 platform は旧行をそのまま
   * 新コードに渡す。 この Issue が塞ぐのは「宣言された版差」だけで、
   * 「宣言されなかった形の変更」はこの契約の外にある。
   */
  readonly stateSchemaVersion?: number;
  /**
   * [Issue #3150] `fromVersion` の版で書かれた state を、この plugin の
   * {@link CoordinationPlugin.stateSchemaVersion} へ持ち上げる純関数。
   *
   * `stateSchemaVersion` が 2 以上を宣言する plugin は **必須** — 持たない plugin は
   * load 時点で拒否される (`coordinationPluginSchemaDefect` 参照)。 その問題全体が最初の
   * 1 リクエストで「使えない」と分かり、 行は 1 つも触られない。 拒否は「plugin が無い」とは
   * 別物として扱われ、 op / projection の両方が 503 になり、 tick は state を進めないまま
   * 行の TTL だけ延ばす (= 直すまでの間に進行中の試合を retention で失わない)。
   *
   * throw したら platform はその行に **一切触れない** (initialState を呼ばない、write しない、
   * reset しない)。 移行できない行を黙って作り直すより、 該当試合だけを安全に止める。
   *
   * ctx (= `CoordinationContext`) は渡さない。 意図的な設計判断: この Issue が実際に踏んだ
   * 4 件の破損は、 どれも「既定値の埋め込み」で足りる形の変更であり、
   * 必要な材料 (team key 等) は state 自身が既に持っている。 ctx を足すと
   * `matchSecret` のような秘密材料が移行の入力に紛れ込む余地ができ、
   * 「移行は state だけを見る純関数」という単純な契約が崩れる。
   */
  migrateState?(state: unknown, fromVersion: number): State;
  /**
   * [Issue #659] 各 team の現在得点 (= 絶対値)。 宣言すると platform の scoreboard に反映される。
   *
   * これが無い間、coordination problem の得点は**構造的に scoreboard へ届かなかった**。
   * builtin の scoring kind (flag / uptime-* / phased-polling / attack-detection) はどれも
   * plugin state を読まないし、採点 Lambda は plugin を実行しない (= 資格情報分離、
   * `coordination-dispatcher-lambda.ts` 参照)。 結果、`scoring` 未宣言の Battle は
   * 「試合中の得点はすべて plugin が判定する」と説明しながら、portal の点数は 0 のままだった。
   *
   * 差分ではなく**絶対値**を返す。 plugin 側が権威で、platform は「今いくつか」を写すだけ
   * (= 差分だと再送 / conflict 再試行で二重加算しうる)。 op / tick の遷移前後に呼ばれ、
   * 前後で変わった team の得点と履歴を、state と同時に保存する配信待ちデータから反映する。
   *
   * optional: 宣言しない plugin は従来どおり scoreboard に何も書かない。
   */
  teamScores?(state: State): Readonly<Record<string, number>>;
  /** Public reason codes only: never copy input, proof, secret or another team's private state. */
  scoreReasons?(
    before: State,
    after: State,
    cause:
      | { readonly kind: "op"; readonly teamId: string; readonly op: Op }
      | { readonly kind: "tick" },
  ): Readonly<Record<string, string>>;
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
