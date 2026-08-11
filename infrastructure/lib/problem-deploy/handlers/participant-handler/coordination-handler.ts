import type { CoordinationContext } from "@tenkacloud/coordination-plugin-sdk";
import {
  loadAndDispatchCoordinationOp,
  loadAndProjectCoordinationForTeam,
  type PluginImporter,
} from "./coordination-plugin-loader.js";
import type { CoordinationStoreDeps } from "./coordination-store.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

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
  readonly tenantId: string;
  readonly eventId: string;
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
    tenantId: scope.tenantId,
    eventId: scope.eventId,
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
      tenantId: scope.tenantId,
      eventId: scope.eventId,
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
 * 注: `ctx.teamIds` は現状 requester 自身のみ。 full event roster の解決は importer 配線
 * (= 実 plugin が load される時) と同 increment で拡張する (plugin が load されない seam 状態では
 * ctx は使われないため安全)。
 */
export function makeCoordinationScopeResolver(
  shared: ParticipantSharedResources,
  config: CoordinationConfig,
): (teamLoginKey: string) => Promise<CoordinationScope | null> {
  return async (teamLoginKey) => {
    const items = await queryTeamItems(shared, teamLoginKey);
    for (const item of items) {
      const problemId = item.problemId;
      const plugin = problemId ? config[problemId]?.plugin : undefined;
      if (problemId && item.tenantId && item.eventId && item.teamId && plugin) {
        return {
          tenantId: item.tenantId,
          eventId: item.eventId,
          teamId: item.teamId,
          ctx: { eventId: item.eventId, teamIds: [item.teamId] },
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
