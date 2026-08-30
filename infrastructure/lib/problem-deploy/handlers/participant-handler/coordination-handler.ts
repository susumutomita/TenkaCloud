import type { CoordinationContext } from "@tenkacloud/coordination-plugin-sdk";
import {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../control-data/domain/coordination-scope.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import {
  loadAndDispatchCoordinationOp,
  loadAndProjectCoordinationForTeam,
  type PluginImporter,
} from "./coordination-plugin-loader.js";
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
}

export interface CoordinationHandlerDeps {
  /** 問題同梱 plugin を動的 import する関数 (= 本番は S3 materialize、 別 increment の seam)。 */
  readonly importer: PluginImporter;
  readonly store: CoordinationStoreDeps;
  /**
   * team-login-key → 実行 scope。 認証不可 / 当該 event に coordination 宣言が無い場合は null
   * (= route は `not_configured` で安全に応答する)。
   */
  readonly resolveScope: (teamLoginKey: string) => Promise<CoordinationScope | null>;
}

export type CoordinationHandlerOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  /** plugin が load 不可 (= importer 未配線 / 壊れた問題 plugin)。 op は適用されない。 */
  | { readonly kind: "unavailable" }
  /** 認証不可 or 当該 event に coordination 宣言が無い (= scope null)。 */
  | { readonly kind: "not_configured" };

/** op を受理 → 適用 → 永続化し、 当該 team 向け projection を返す (= write 経路)。 */
export async function handleCoordinationOp(
  deps: CoordinationHandlerDeps,
  teamLoginKey: string,
  op: unknown,
  nowIso: string,
): Promise<CoordinationHandlerOutcome> {
  const scope = await deps.resolveScope(teamLoginKey);
  if (!scope) return { kind: "not_configured" };
  const outcome = await loadAndDispatchCoordinationOp(deps.importer, scope.moduleRef, deps.store, {
    scope: scope.state,
    teamId: scope.teamId,
    op,
    ctx: scope.ctx,
    fallbackProjection: scope.fallbackProjection,
    nowIso,
  });
  return outcome.kind === "plugin_unavailable" ? { kind: "unavailable" } : outcome;
}

/** 当該 team の現在 projection を読む (= 書き込みなし、 portal polling 用)。 */
export async function handleCoordinationProjection(
  deps: CoordinationHandlerDeps,
  teamLoginKey: string,
): Promise<CoordinationHandlerOutcome> {
  const scope = await deps.resolveScope(teamLoginKey);
  if (!scope) return { kind: "not_configured" };
  const projection = await loadAndProjectCoordinationForTeam(
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
  return { kind: "ok", projection };
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
 */
function canSubmitCoordination(item: { readonly status?: string }): boolean {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  return !DELETED_LIKE_STATUSES.has(status);
}

export function makeCoordinationScopeResolver(
  shared: ParticipantSharedResources,
  config: CoordinationConfig,
): (teamLoginKey: string) => Promise<CoordinationScope | null> {
  return async (teamLoginKey) => {
    const items = await queryTeamItems(shared, teamLoginKey);
    for (const item of items) {
      const problemId = item.problemId;
      const plugin = problemId ? config[problemId]?.plugin : undefined;
      if (
        problemId &&
        item.tenantId &&
        item.eventId &&
        item.teamId &&
        plugin &&
        canSubmitCoordination(item)
      ) {
        const teamIds = await resolveEventRoster(shared, {
          tenantId: item.tenantId,
          eventId: item.eventId,
          problemId,
          requesterTeamId: item.teamId,
        });
        return {
          // [Issue #3123] runId は problemId のエイリアスにしない。 同じ値を入れると 2 つの
          // 次元が区別できなくなり、 将来 run id が problem id と一致した瞬間に別 run の
          // state が衝突する。 platform は現状 (event, problem) あたり 1 run しか作らないので
          // 明示的な既定値を発行し、 run reset は「この namespace を消す」で表現する。
          state: {
            tenantId: item.tenantId,
            eventId: item.eventId,
            problemId,
            runId: DEFAULT_COORDINATION_RUN_ID,
          },
          teamId: item.teamId,
          ctx: { eventId: item.eventId, teamIds },
          // moduleRef は problemId (importer の key `coordination/<id>.mjs`)。
          // plugin path は宣言の有無判定にのみ使い、 実 load は problemId-keyed bundle を引く。
          moduleRef: problemId,
          fallbackProjection: {},
        };
      }
    }
    return null;
  };
}
