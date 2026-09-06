/**
 * scoring-driven tick Issue #2324: generic scoring Lambda → CoordinationDispatcher Lambda の
 * **直接 Invoke wire contract**。
 *
 * 資格情報分離を守るため、 pack-author 由来の coordination plugin は最小 IAM の
 * CoordinationDispatcher Lambda 内でのみ実行する (= op 経路 `applyOp` と同じ場所)。 採点 Lambda
 * (= ssm:GetParameter / kms:Decrypt を持つ) は plugin を **load / 実行しない**。 代わりに per-minute
 * pass で「どの event が coordination を宣言しているか」だけを判定し、 tick 対象を batch にまとめて
 * dispatcher を 1 回 async Invoke する。 本 module はその payload 型を両 Lambda で共有する
 * (= SDK / plugin code 非依存、 採点 bundle を膨らませない pure contract)。
 */

/** 直接 Invoke の payload を tick batch と識別する discriminator。 */
export const COORDINATION_TICK_ACTION = "coordination-tick";

/** 1 event 分の tick 対象 (= dispatcher が plugin を load して runTick する単位)。 */
export interface CoordinationTickTarget {
  readonly tenantId: string;
  readonly eventId: string;
  /** 動的 load の key (= problemId。 dispatcher の scope resolver と同じ moduleRef 規約)。 */
  readonly moduleRef: string;
  /** event 開始からの経過 ms (= 採点 pass が `nowMs - eventStartMs` で算出した plugin の tick 時刻)。 */
  readonly eventNowMs: number;
  /** row 未初期化時の `initialState(ctx)` に渡す参加チーム一覧 (= 採点 pass が scan で観測)。 */
  readonly teamIds: readonly string[];
  /** Completed event: publish only already-saved scores, without loading or advancing the game. */
  readonly drainOnly?: boolean;
}

/** 採点 pass が dispatcher に渡す 1 tick 分の batch (= 1 invoke/分、 event 数によらず 1 回)。 */
export interface CoordinationTickBatch {
  readonly action: typeof COORDINATION_TICK_ACTION;
  /** write の `updatedAt` に使う tick 起動時刻 (ISO8601)。 */
  readonly nowIso: string;
  readonly targets: readonly CoordinationTickTarget[];
}
