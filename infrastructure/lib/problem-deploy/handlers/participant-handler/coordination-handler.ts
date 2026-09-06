import type { CoordinationContext } from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationArtifactStore } from "../../control-data/coordination-artifact-store.js";
import type { CoordinationArtifactRef } from "../../control-data/domain/coordination-artifact.js";
import type { CoordinationStateBudget } from "../../control-data/domain/coordination-budget.js";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import type { RoundWindow } from "../generic-scoring-handler/round-liveness.js";
import { isScoringActive } from "../generic-scoring-handler/scoring-active.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { resolveCurrentCoordinationRunId } from "../shared/coordination-run.js";
import { getPrerequisiteBlockByEventId } from "./challenge-access.js";
import {
  type ArtifactFetchOutcome,
  discardArtifacts,
  fetchAuthorizedArtifact,
  parseArtifactSubmissions,
  storeArtifactSubmissions,
  withArtifactRefs,
} from "./coordination-artifacts.js";
import {
  loadAndDispatchCoordinationOp,
  loadAndProjectCoordinationForTeam,
  type PluginImporter,
} from "./coordination-plugin-loader.js";
import { resolveEventRoster } from "./coordination-roster.js";
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
   * [Issue #3152] Where immutable submission bodies live.
   *
   * Required rather than optional: a host without one still has to answer
   * "where did this proof go", and the only honest answers are "nowhere" or
   * "refused". `UnconfiguredCoordinationArtifactStore` is the second, and it is
   * what a deployment with no bucket gets — an operation carrying a body is
   * refused loudly instead of being accepted with the body discarded.
   */
  readonly artifacts: CoordinationArtifactStore;
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
  | { readonly kind: "ambiguous"; readonly problemIds: readonly string[] }
  /**
   * [Issue #3170] Progression Gate が未完了。 op も projection も拒否する。
   * `gateProblemId` は先に完了すべき問題 (= 参加者に見せる導線)。
   */
  | { readonly kind: "locked"; readonly gateProblemId: string };

export type CoordinationHandlerOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  /** plugin が load 不可 (= importer 未配線 / 壊れた問題 plugin)。 op は適用されない。 */
  | { readonly kind: "unavailable" }
  /** 認証不可 or 当該 event に coordination 宣言が無い (= scope null)。 */
  | { readonly kind: "not_configured" }
  /** [Issue #3170] Gate challenge 未完了。 op は適用されない。 */
  | { readonly kind: "locked"; readonly gateProblemId: string }
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
  /**
   * [Issue #3152] Immutable bodies submitted with this operation, still encoded
   * as they arrived. Absent for every operation that carries none, which is
   * most of them.
   */
  rawArtifacts?: unknown,
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

  // [Issue #3152] Bodies are stored BEFORE dispatch so the plugin only ever
  // sees references and stays a pure function. Everything written here is
  // withdrawn again if the operation does not survive, because in that case
  // nothing in the state refers to it and no teardown would ever find it.
  const parsedArtifacts = parseArtifactSubmissions(rawArtifacts);
  if (!parsedArtifacts.ok) return { kind: "rejected", error: parsedArtifacts.error };
  const stored = await storeArtifactSubmissions(
    deps.artifacts,
    scope.state,
    parsedArtifacts.submissions,
  );
  if (stored.kind === "scope_deleted") return { kind: "rejected", error: "event_ended" };
  const storedRefs: readonly CoordinationArtifactRef[] = Object.values(stored.refs);

  const outcome = await loadAndDispatchCoordinationOp(deps.importer, scope.moduleRef, deps.store, {
    scope: scope.state,
    teamId: scope.teamId,
    op: withArtifactRefs(op, stored.refs),
    ctx: scope.ctx,
    fallbackProjection: scope.fallbackProjection,
    nowIso,
  });
  // Anything other than a committed op leaves the bodies unreferenced.
  if (outcome.kind !== "ok" && storedRefs.length > 0) {
    await discardArtifacts(deps.artifacts, scope.state, storedRefs);
  }
  if (outcome.kind === "plugin_unavailable") return { kind: "unavailable" };
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

/** 当該 team の現在 projection を読む。保存済み採点の配信のみ再試行する。 */
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
 * [Issue #3152] Reads one artifact body for a team, if that team's own
 * projection refers to it.
 *
 * Routed through the projection rather than through a permission list of its
 * own, because the plugin already answers "what may this team see" and a second
 * answer could disagree with the first. It is also why this is a normal
 * read path: computing the projection is what polling already does, so
 * authorizing a fetch costs no more than a poll.
 */
export async function handleCoordinationArtifactFetch(
  deps: CoordinationHandlerDeps,
  teamLoginKey: string,
  artifactId: string,
  problemId?: string,
): Promise<
  | ArtifactFetchOutcome
  | Extract<
      CoordinationHandlerOutcome,
      | { kind: "not_configured" }
      | { kind: "ambiguous" }
      | { kind: "schema_mismatch" }
      | { kind: "locked" }
    >
> {
  const resolution = await deps.resolveScope(teamLoginKey, problemId);
  if (resolution.kind !== "scope") return resolution;
  const scope = resolution.scope;
  const projected = await loadAndProjectCoordinationForTeam(
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
  // A plugin that will not load yields the empty fallback projection, which
  // references no artifact and therefore authorizes none. Fail-closed is the
  // right direction here: without the plugin there is nothing that can say who
  // may read what.
  if (projected.kind === "schema_mismatch") {
    // The board this fetch would be authorized against cannot be built, so
    // there is no honest answer about what this team may read. Refusing beats
    // falling back to the empty projection, which would deny every artifact and
    // look like the artifacts had gone.
    warnSchemaMismatch("projection", scope.state, projected);
    return projected;
  }
  return fetchAuthorizedArtifact(deps.artifacts, scope.state, projected.projection, artifactId);
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
export type CoordinationConfig = Readonly<
  Record<string, { readonly plugin: string; readonly scoreMode?: "exclusive" | "additive" }>
>;

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
 * (`coordination-roster.ts`) deliberately does not filter by status, for an
 * unrelated and still-valid reason: dropping mid-deploy teams from the roster
 * would make `initialState(ctx)` depend on deploy timing (#3053).
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

/**
 * team-login-key → {@link CoordinationScope}。 active な代表 deployment 行から tenant/event/team を
 * 引き、 その問題が coordination を宣言していれば moduleRef を確定する。 認証不可 / 未宣言は
 * `not_configured`。
 *
 * `ctx.teamIds` は **event の full roster** (= 同じ event で同じ問題を deploy している全チーム、
 * teamId 昇順) を渡す。 requester 1 チームだけを渡していた頃 (Issue #3053) は、 plugin の
 * `initialState(ctx)` が requester しか state に登録できず、 相手チームを対象にする op
 * (`ac26-crypto-battle` の `hunt` など) が必ず `unknown team` で reject されていた。 roster の
 * 定義・ソート・失敗時の縮退は tick 経路と共有する `resolveEventRoster`
 * (`coordination-roster.ts`) が持つ。
 */
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
    // [Issue #3170] The Progression Gate has to reach this route too.
    //
    // `challenge-access.ts` guards flag submission, hint reveal, endpoint
    // registration and the credential paths — every participant route that
    // lives in the portal Lambda. Coordination was split into its own minimal-
    // IAM Lambda by #1420 and the guard did not come with it, so a Battle whose
    // Gate challenge was untouched stayed fully playable: on live, a team with
    // `hello-world` incomplete started the match, LEAKed three shares and landed
    // a HUNT for +25, all while the page above the board said the problem was
    // locked. The Gate was a label, not a lock.
    //
    // Both the op and the projection are refused, because the banner the
    // participant reads says the problem's detail is inaccessible — leaving the
    // board readable would contradict it, and a readable board is also the
    // opponent's public record.
    const prerequisite = await getPrerequisiteBlockByEventId(
      shared,
      items,
      resolvedProblemId,
      item.eventId,
    );
    if (prerequisite) {
      return { kind: "locked", gateProblemId: prerequisite.gateProblemId };
    }
    const roster = await resolveEventRoster(shared, {
      tenantId: item.tenantId,
      eventId: item.eventId,
      problemId: resolvedProblemId,
      knownTeamIds: [item.teamId],
    });
    return {
      kind: "scope",
      scope: {
        // [Issue #3123] runId は problemId のエイリアスにしない。 同じ値を入れると 2 つの
        // 次元が区別できなくなり、 将来 run id が problem id と一致した瞬間に別 run の
        // state が衝突する。
        //
        // [Issue #3153] 値は run pointer から引く。 ここを定数にしていた間、 reset は
        // 「この namespace を消す」でしか表現できず、 直前の試合は残らなかった。 pointer が
        // 無い (= 一度も reset されていない) 問題は初期 run に解決するので、 この変更の前から
        // 進行中の試合はそのまま続く。
        state: {
          tenantId: item.tenantId,
          eventId: item.eventId,
          problemId: resolvedProblemId,
          runId: await resolveCurrentCoordinationRunId(await resolveDeploymentsRepository(shared), {
            tenantId: item.tenantId,
            eventId: item.eventId,
            problemId: resolvedProblemId,
          }),
        },
        teamId: item.teamId,
        ctx: {
          eventId: item.eventId,
          teamIds: roster.teamIds,
          // [Issue #3172] So a plugin can name an opponent instead of printing its ULID.
          teamNames: roster.teamNames,
        },
        window: { eventStartsAt: item.eventStartsAt, eventEndsAt: item.eventEndsAt },
        // moduleRef は problemId (importer の key `coordination/<id>.mjs`)。
        // plugin path は宣言の有無判定にのみ使い、 実 load は problemId-keyed bundle を引く。
        moduleRef: resolvedProblemId,
        fallbackProjection: {},
      },
    };
  };
}
