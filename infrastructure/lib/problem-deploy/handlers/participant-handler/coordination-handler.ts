import type { CoordinationContext } from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateBudget } from "../../control-data/domain/coordination-budget.js";
import {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../control-data/domain/coordination-scope.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import type { RoundWindow } from "../generic-scoring-handler/round-liveness.js";
import { isScoringActive } from "../generic-scoring-handler/scoring-active.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import {
  loadAndDispatchCoordinationOp,
  loadAndProjectCoordinationForTeam,
  type PluginImporter,
} from "./coordination-plugin-loader.js";
import type { StateSchemaMismatchReason } from "./coordination-state-schema.js";
import type { CoordinationStoreDeps } from "./coordination-store.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * Issue #1420: 参加者 portal 向け coordination route の handler。
 *
 * route は team-login-key で認証し、 {@link CoordinationHandlerDeps.resolveScope} が tenant/event/team
 * scope + 問題が宣言した plugin の module path (interTeamCoordination.plugin) を解決する。 そこから先は
 * #1606 の dispatcher core + #1617 の動的 loader に委譲するだけで、 platform は問題依存の意味論を持たない。
 *
 * importer は問題同梱 plugin の bundle を materialize して import する seam。本 handler は
 * importer を注入で受け、load 不可 (= 未配線 / 壊れた問題) は
 * `unavailable` / fallback projection で participant API を壊さない。
 */

/** route が解決した 1 回分の実行 scope。 resolveScope が null を返したら scope 不成立。 */
export interface CoordinationScope {
  /**
   * [Issue #3123] 永続化 namespace (tenant x event x problem x run)。 platform 所有。
   */
  readonly state: CoordinationStateScope;
  readonly teamId: string;
  /** plugin の initialState に渡す event 文脈 (= 参加チーム一覧)。 */
  readonly ctx: CoordinationContext;
  /** 問題が宣言する plugin module path (= interTeamCoordination.plugin)。 */
  readonly moduleRef: string;
  /** projection 失敗 / 未初期化時に返す安全な既定 (= 他 team の機密を出さない)。 */
  readonly fallbackProjection: unknown;
  /**
   * [Issue #3123] deployment 行に denormalize された event の開始 / 終了。 op 経路が
   * `isScoringActive` で終端を判定するために持つ (= 追加 read 無し。 resolver は clock を
   * 持たないので、 判定は nowIso を持つ handler 側で行う)。
   */
  readonly window: RoundWindow;
}

export interface CoordinationHandlerDeps {
  /** 問題同梱 plugin を動的 import する関数 (= 本番は S3 materialize、 別 increment の seam)。 */
  readonly importer: PluginImporter;
  readonly store: CoordinationStoreDeps;
  /**
   * team-login-key → 実行 scope。 認証不可 / 当該 event に coordination 宣言が無い場合は null
   * (= route は `not_configured` で安全に応答する)。
   */
  readonly resolveScope: (
    teamLoginKey: string,
    problemId?: string,
  ) => Promise<CoordinationScopeResolution>;
  /**
   * [Issue #659] Copies the plugin's team scores onto the deployment rows the
   * scoreboard reads. Optional so a host without it keeps the previous
   * behaviour (= the match scores, and the scoreboard never hears about it).
   */
  readonly publishScores?: (
    scope: CoordinationStateScope,
    scores: Readonly<Record<string, number>>,
    nowIso: string,
  ) => Promise<void>;
}

/**
 * [Issue #3125] scope 解決の結果。
 *
 * 以前は `CoordinationScope | null` で、 team に coordination problem が 2 つ deploy されて
 * いても「最初に条件を満たした 1 件」を返していた。 2 問目は participant API から到達できず、
 * しかも**失敗として現れない** — 1 問目の projection が正常に返るので、 参加者にも運営にも
 * 「2 問目が存在しない」ようにしか見えなかった。
 *
 * 曖昧なときに片方を黙って選ぶのをやめる。 coordination problem が 1 つだけの event
 * (= 大多数) は `problemId` 省略のまま従来どおり動くので、 呼び出し側の変更は不要。
 */
export type CoordinationScopeResolution =
  | { readonly kind: "scope"; readonly scope: CoordinationScope }
  /** 認証不可 / 当該 event に coordination 宣言が無い / 指定 problemId が当該 team に無い。 */
  | { readonly kind: "not_configured" }
  /** `problemId` 省略で候補が複数。 候補を返して選択を要求する。 */
  | { readonly kind: "ambiguous"; readonly problemIds: readonly string[] };

export type CoordinationHandlerOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  /** plugin が load 不可 (= importer 未配線 / 壊れた問題 plugin)。 op は適用されない。 */
  | { readonly kind: "unavailable" }
  /** 認証不可 or 当該 event に coordination 宣言が無い (= scope null)。 */
  | { readonly kind: "not_configured" }
  /**
   * [Issue #3125] `problemId` 省略で coordination problem が複数ある。 どれか 1 つを勝手に
   * 選ぶと 2 問目が永久に到達不能になるので、 候補を返して選択を要求する。
   */
  | { readonly kind: "ambiguous"; readonly problemIds: readonly string[] }
  /**
   * [Issue #3150] 行の `stateSchemaVersion` を、 load できた plugin と突き合わせられなかった。
   * op 経路 / projection 経路のどちらも、 このとき行には一切触れない
   * (`coordination-state-schema.ts` 参照)。
   */
  | {
      readonly kind: "schema_mismatch";
      readonly reason: StateSchemaMismatchReason;
      /** `migration_failed` の throw メッセージ。 ログ専用で HTTP 応答には載せない。 */
      readonly detail?: string;
    }
  /**
   * [Issue #3151] op は適用できたが、 その結果の state が選択中 backend の予算に収まらず、
   * platform が write を拒んだ。 行は op 前のまま。
   *
   * `rejected` と分ける。 `rejected` は plugin が参加者の手を却下したという意味で、 参加者は
   * 別の手を指せばよい。 これは platform 側に置き場所が無いという意味で、 どんな手を指しても
   * 変わらない — 混ぜると参加者は永久に指し直し続けることになる。
   */
  | {
      readonly kind: "too_large";
      readonly bytes?: number;
      readonly budget: CoordinationStateBudget;
    };

/** op を受理 → 適用 → 永続化し、 当該 team 向け projection を返す (= write 経路)。 */
export async function handleCoordinationOp(
  deps: CoordinationHandlerDeps,
  teamLoginKey: string,
  op: unknown,
  nowIso: string,
  problemId?: string,
): Promise<CoordinationHandlerOutcome> {
  const resolution = await deps.resolveScope(teamLoginKey, problemId);
  if (resolution.kind !== "scope") return resolution;
  const scope = resolution.scope;
  // [Issue #3123] 終了した event の試合は書き換えられない。 status だけを見ていると、
  // `endEvent` が `eventEndsAt` を刻んだ後も deployment 行は `COMPLETE` のまま残るため、
  // 参加者が終わった試合を変更でき、 さらに write のたびに `expiresAt` が更新されて
  // retention が始まらない (= tick 側を `isScoringActive` で止めた意味が消える)。
  // 判定は tick collector と同一の predicate。 projection (read) は素通しする —
  // 読むだけなら TTL も state も動かないし、 event 後の振り返りを壊す理由がない。
  if (!isScoringActive(scope.window, nowIso)) return { kind: "rejected", error: "event_ended" };
  const outcome = await loadAndDispatchCoordinationOp(deps.importer, scope.moduleRef, deps.store, {
    scope: scope.state,
    teamId: scope.teamId,
    op,
    ctx: scope.ctx,
    fallbackProjection: scope.fallbackProjection,
    nowIso,
  });
  if (outcome.kind === "plugin_unavailable") return { kind: "unavailable" };
  if (outcome.kind === "ok" && outcome.changedScores && deps.publishScores) {
    // [Issue #659] The op is already committed. A scoreboard write that fails
    // must not be reported to the participant as a rejected move — it would be
    // a lie about their own state, and the next op recomputes the figure from
    // the plugin's absolute score anyway. The guard belongs HERE and not only
    // inside the default publisher, because `publishScores` is injected and a
    // host can supply one that throws.
    await deps.publishScores(scope.state, outcome.changedScores, nowIso).catch((err: unknown) => {
      console.warn("[coordination] scoreboard update failed; the next op will repair it", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // [Issue #3150] `CoordinationDispatchOutcome`'s `schema_mismatch` variant
  // (`{ kind, reason }`) is returned as-is here -- it already has the exact
  // shape `CoordinationHandlerOutcome`'s `schema_mismatch` declares, so no
  // separate mapping is needed the way `plugin_unavailable` -> `unavailable`
  // above needed one. It IS logged: the participant sees a 503, but the
  // operator is the one who has to act (redeploy a plugin that migrates), and
  // a 503 that only the participant sees is the silent failure this issue
  // exists to end.
  if (outcome.kind === "schema_mismatch") warnSchemaMismatch("op", scope.state, outcome);
  return outcome;
}

/** 当該 team の現在 projection を読む (= 書き込みなし、 portal polling 用)。 */
export async function handleCoordinationProjection(
  deps: CoordinationHandlerDeps,
  teamLoginKey: string,
  problemId?: string,
): Promise<CoordinationHandlerOutcome> {
  const resolution = await deps.resolveScope(teamLoginKey, problemId);
  if (resolution.kind !== "scope") return resolution;
  const scope = resolution.scope;
  const outcome = await loadAndProjectCoordinationForTeam(
    deps.importer,
    scope.moduleRef,
    deps.store,
    {
      scope: scope.state,
      teamId: scope.teamId,
      ctx: scope.ctx,
      fallbackProjection: scope.fallbackProjection,
    },
  );
  // [Issue #3150] mismatch を 200 に丸めない -- 呼び出し側 (dispatcher-handler) が 503 に写す。
  if (outcome.kind === "schema_mismatch") {
    warnSchemaMismatch("projection", scope.state, outcome);
    return outcome;
  }
  return { kind: "ok", projection: outcome.projection };
}

/**
 * [Issue #3150] One log line per refused request, on both paths, naming the
 * scope and the reason (and the thrown message for `migration_failed`). The
 * tick host logs the same way. Without this the only signal of a mismatched
 * deploy is a participant's 503.
 */
function warnSchemaMismatch(
  path: "op" | "projection",
  scope: CoordinationStateScope,
  outcome: { readonly reason: StateSchemaMismatchReason; readonly detail?: string },
): void {
  console.warn(
    `[coordination] ${path} refused: state schema mismatch event=${scope.eventId} problem=${scope.problemId} run=${scope.runId} reason=${outcome.reason}` +
      (outcome.detail ? ` detail=${JSON.stringify(outcome.detail)}` : ""),
  );
}

/** `{ [problemId]: { plugin } }`。 問題が宣言する coordination plugin の module path を引く。 */
export type CoordinationConfig = Readonly<Record<string, { readonly plugin: string }>>;

/**
 * `PROBLEM_COORDINATION` env (JSON) を parse する。 未設定 / 不正 JSON / 非 object は `{}` (=
 * coordination 無効) を返す (= scoring/endpoints env と同方針)。 CDK が問題 metadata の
 * interTeamCoordination を集約して渡す想定で、 未配線の間は空 = 全 route が `not_configured`。
 */
export function parseCoordinationConfig(raw: string | undefined): CoordinationConfig {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CoordinationConfig) : {};
  } catch {
    return {};
  }
}

/**
 * team-login-key → {@link CoordinationScope}。 active な代表 deployment 行から tenant/event/team を
 * 引き、 その問題が coordination を宣言していれば moduleRef を確定する。 認証不可 / 未宣言は null
 * (= route は `not_configured`)。
 *
 * `ctx.teamIds` は **event の full roster** (= 同じ event で同じ問題を deploy している全チーム、
 * teamId 昇順) を渡す。 requester 1 チームだけを渡していた頃 (Issue #3053) は、 plugin の
 * `initialState(ctx)` が requester しか state に登録できず、 相手チームを対象にする op
 * (`ac26-crypto-battle` の `hunt` など) が必ず `unknown team` で reject されていた。 さらに
 * 各チームが別々の 1 チーム ctx で同じ state 行を初期化しに行くため、 先に書いた側の state に
 * もう一方が存在しない、 という競合も起きていた。
 *
 * roster は teamId でソートして渡す。 これが競合対策の本体で、 どのチームの request が先に
 * state を materialize しても `initialState(ctx)` の入力が同一になる (= 同じ initial state)。
 *
 * roster の定義は「同じ (tenant, event) で **同じ problemId** の deployment 行を持つチーム」。
 * status は絞らない — deploy 途中のチームを外すと、 完了の前後で roster が変わり、 まさに
 * 上の競合が再発するため。
 *
 * 既知の限界: state は最初の op で 1 度だけ materialize される。 それより後に deploy した
 * チームは `state.teams` に現れない (SDK に roster 再解決の hook が無い)。 運用は全チームの
 * deploy 完了後に試合を開始する。
 */
/**
 * 同じ (tenant, event) で同じ問題を deploy している全チーム ID を teamId 昇順で返す
 * (Issue #3053)。 requester は必ず含む — roster query が (transient error などで) 落ちても
 * requester だけの ctx で従来どおり動く方が、 route ごと落とすより安全なため。
 */
/**
 * [Issue #659] Copy the plugin's team scores onto the deployment rows the
 * scoreboard reads.
 *
 * A coordination Battle decides its own scoring — `ac26-crypto-battle`'s
 * metadata says so outright — but nothing carried the figure anywhere the
 * platform looks. `scoring` is undeclared for such problems (there is no
 * builtin kind that could serve them), and the scoring Lambda deliberately does
 * not run plugins, so the portal showed 0 for a team that had been playing for
 * an hour.
 *
 * The dispatcher already holds the answer and already has DynamoDB write
 * permission on this table, so it writes: no new IAM, no new invocation path,
 * and no coupling of the scoring loop to plugin execution.
 *
 * The plugin reports ABSOLUTE scores and the row stores a running total, so the
 * delta is `target - current`. That is what makes this safe to repeat: a retry,
 * or two ops racing, converge on the plugin's figure instead of double-counting
 * the way a delta-based report would.
 *
 * Failure is logged, never thrown. The op is already committed at this point;
 * turning a scoreboard write into a rejection would tell the participant their
 * move failed when it did not, and the next op repairs the figure anyway.
 */
export function makeCoordinationScorePublisher(
  shared: ParticipantSharedResources,
): NonNullable<CoordinationHandlerDeps["publishScores"]> {
  return (scope, scores, nowIso) =>
    publishTeamScores(
      shared,
      { tenantId: scope.tenantId, eventId: scope.eventId, problemId: scope.problemId },
      scores,
      nowIso,
    );
}

async function publishTeamScores(
  shared: ParticipantSharedResources,
  target: { readonly tenantId: string; readonly eventId: string; readonly problemId: string },
  scores: Readonly<Record<string, number>>,
  nowIso: string,
): Promise<void> {
  try {
    const repository = await resolveDeploymentsRepository(shared);
    const rows = await repository.listByTenantAndEvent(target.tenantId, target.eventId);
    for (const row of rows) {
      if (row.problemId !== target.problemId) continue;
      const teamId = row.teamId;
      const jobId = row.jobId;
      if (typeof teamId !== "string" || typeof jobId !== "string") continue;
      const wanted = scores[teamId];
      if (wanted === undefined) continue;
      const delta = wanted - (typeof row.score === "number" ? row.score : 0);
      if (delta === 0) continue;
      await repository.applyKindScoringResult(jobId, { scoreDelta: delta }, nowIso);
    }
  } catch (err) {
    console.warn("[coordination] scoreboard update failed; the next op will repair it", {
      eventId: target.eventId,
      problemId: target.problemId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resolveEventRoster(
  shared: ParticipantSharedResources,
  target: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly problemId: string;
    readonly requesterTeamId: string;
  },
): Promise<readonly string[]> {
  const roster = new Set<string>([target.requesterTeamId]);
  try {
    const repository = await resolveDeploymentsRepository(shared);
    const rows = await repository.listByTenantAndEvent(target.tenantId, target.eventId);
    for (const row of rows) {
      if (row.problemId === target.problemId && typeof row.teamId === "string" && row.teamId) {
        roster.add(row.teamId);
      }
    }
  } catch {
    // roster 解決の失敗は coordination route を落とさない (requester のみで継続)。
  }
  return [...roster].sort();
}

/**
 * [Issue #3123] Whether this deployment row may still submit coordination ops.
 *
 * A torn-down deployment stays queryable through the participant login index
 * (GSI2 is keyed by `teamLoginKey`, not by status) while it sits in `DELETING`,
 * and terminal rows are retained for seven days for audit. Without this guard a
 * participant could keep submitting after their deployment — or their whole
 * event — was torn down, and because event cleanup now DELETES the coordination
 * namespace, the next op would re-materialize it from `plugin.initialState`,
 * recreating exactly the row teardown had just removed.
 *
 * Every other participant write path already applies this same filter with this
 * same constant (`battle-attacks.ts`, `cast-event.ts`, `sso.ts`, `lookup.ts`,
 * `update.ts`, `score-events.ts`, `leaderboard*.ts`, `challenge-access.ts`).
 * Coordination was the one that did not.
 *
 * Note this guards the REQUESTER's own row only. `resolveEventRoster`
 * deliberately does not filter by status, for an unrelated and still-valid
 * reason: dropping mid-deploy teams from the roster would make
 * `initialState(ctx)` depend on deploy timing (#3053).
 *
 * [Issue #3128] Status alone is not enough, because a torn-down row does not
 * stay in a deleted-like status. `bulkTeardownEvent` moves rows to `DELETING`
 * and — once nothing is uncommitted — DELETES the coordination namespace. The
 * delete state machine then runs asynchronously, and on `DELETE_FAILED` (or a
 * task failure) `markFailed` moves the row to `FAILED`, which is
 * indistinguishable from a failed DEPLOY and is therefore NOT deleted-like. The
 * event window is usually still open at that point, so the row passed both
 * gates and the next op re-materialized the namespace teardown had just
 * removed — the participant kept playing a match the operator had ended.
 *
 * `teardownRequestedAt` closes that: it is stamped once when the row first
 * transitions to `DELETING` and never cleared, so "was teardown requested" no
 * longer depends on where the row happened to land afterwards. Rows written
 * before this marker existed do not carry it and keep the previous
 * status-only behaviour; the field's absence means "unknown", not "not torn
 * down".
 */
function canSubmitCoordination(item: {
  readonly status?: string;
  readonly teardownRequestedAt?: string;
}): boolean {
  if (item.teardownRequestedAt) return false;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  return !DELETED_LIKE_STATUSES.has(status);
}

export function makeCoordinationScopeResolver(
  shared: ParticipantSharedResources,
  config: CoordinationConfig,
): (teamLoginKey: string, problemId?: string) => Promise<CoordinationScopeResolution> {
  return async (teamLoginKey, problemId) => {
    const items = await queryTeamItems(shared, teamLoginKey);
    // [Issue #3125] 候補を**全部**集める。 以前はループ内で最初の 1 件を return していたため、
    // 同じ team に 2 つ目の coordination problem が deploy されていても到達できなかった。
    const candidates = items.filter(
      (item) =>
        item.problemId &&
        item.tenantId &&
        item.eventId &&
        item.teamId &&
        config[item.problemId]?.plugin &&
        canSubmitCoordination(item),
    );
    const wanted = problemId
      ? candidates.filter((item) => item.problemId === problemId)
      : candidates;
    // problemId 指定で該当なし = その team にその問題は無い。 存在する別問題を代わりに
    // 返すと、 参加者は指定した問題を操作したつもりで別の試合を動かすことになる。
    if (wanted.length === 0) return { kind: "not_configured" };
    if (wanted.length > 1) {
      const problemIds = [...new Set(wanted.map((item) => String(item.problemId)))].sort();
      // 1 問しか無いのに重複行がある場合 (= 同一 problem の複数 deployment 行) は曖昧では
      // ないので、 そのまま解決する。
      if (problemIds.length > 1) return { kind: "ambiguous", problemIds };
    }
    const item = wanted[0];
    if (!item?.problemId || !item.tenantId || !item.eventId || !item.teamId) {
      return { kind: "not_configured" };
    }
    const resolvedProblemId = item.problemId;
    const teamIds = await resolveEventRoster(shared, {
      tenantId: item.tenantId,
      eventId: item.eventId,
      problemId: resolvedProblemId,
      requesterTeamId: item.teamId,
    });
    return {
      kind: "scope",
      scope: {
        // [Issue #3123] runId は problemId のエイリアスにしない。 同じ値を入れると 2 つの
        // 次元が区別できなくなり、 将来 run id が problem id と一致した瞬間に別 run の
        // state が衝突する。 platform は現状 (event, problem) あたり 1 run しか作らないので
        // 明示的な既定値を発行し、 run reset は「この namespace を消す」で表現する。
        state: {
          tenantId: item.tenantId,
          eventId: item.eventId,
          problemId: resolvedProblemId,
          runId: DEFAULT_COORDINATION_RUN_ID,
        },
        teamId: item.teamId,
        ctx: { eventId: item.eventId, teamIds },
        window: { eventStartsAt: item.eventStartsAt, eventEndsAt: item.eventEndsAt },
        // moduleRef は problemId (importer の key `coordination/<id>.mjs`)。
        // plugin path は宣言の有無判定にのみ使い、 実 load は problemId-keyed bundle を引く。
        moduleRef: resolvedProblemId,
        fallbackProjection: {},
      },
    };
  };
}
