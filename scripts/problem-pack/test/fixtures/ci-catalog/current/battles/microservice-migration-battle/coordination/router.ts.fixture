/**
 * ADR-028 / Issue #1420: microservice-migration-battle の参照 inter-team coordination plugin。
 *
 * 各チームは users / orders / catalog を Lambda / ECS / App Runner へ移行し、 切り出した service の
 * 公開 URL をここに register する。 platform の dispatcher が本 plugin を host し、 全チームの
 * 登録 route を共有 directory として各チームに projection する (= 簡易 service mesh)。 これにより
 * 「他チームが移行済みの service を呼び出す」 cross-team interaction が成立する。
 *
 * semantics は本 plugin に閉じ (platform は validate→apply→project を回すだけ)、 metadata.json の
 * `interTeamCoordination.plugin` がこのファイルを指す。 route は公開エンドポイントなので projection で
 * 全チーム分を見せてよい (= 機密ではない)。 https のみ受理し、 plaintext / 不正 service 名は拒否。
 */

import {
  type CoordinationPlugin,
  defineCoordinationPlugin,
} from "@tenkacloud/coordination-plugin-sdk";

/** 移行対象の service。 metadata 側 service 構成 (users / orders / catalog) と一致させる。 */
const SERVICES = ["users", "orders", "catalog"] as const;
type ServiceName = (typeof SERVICES)[number];

/** 1 event 1 row の共有 state。 teamId → service → 公開 URL。 */
interface RouterState {
  /** teamId → (service → url)。 未登録 service は key 自体が無い。 */
  readonly routes: Record<string, Partial<Record<ServiceName, string>>>;
}

/** team が送る operation (= cast-event payload)。 */
type RouterOp =
  | { readonly kind: "register"; readonly service: ServiceName; readonly url: string }
  | { readonly kind: "unregister"; readonly service: ServiceName };

/** その team の portal に返す投影。 全チームの公開 route directory (route は機密でない)。 */
interface RouterProjection {
  /** teamId → (service → url) の全チーム分。 自チーム含む (= 自分の登録確認にも使う)。 */
  readonly directory: Record<string, Partial<Record<ServiceName, string>>>;
}

const isService = (s: string): s is ServiceName => (SERVICES as readonly string[]).includes(s);

const router: CoordinationPlugin<RouterState, RouterOp, RouterProjection> = {
  initialState: (ctx) => ({
    routes: Object.fromEntries(ctx.teamIds.map((teamId) => [teamId, {}])),
  }),

  validateOp: (_state, _teamId, op) => {
    if (!isService(op.service)) return { ok: false, error: "unknown_service" };
    if (op.kind === "register" && !op.url.startsWith("https://")) {
      return { ok: false, error: "must_be_https" };
    }
    return { ok: true };
  },

  applyOp: (state, teamId, op) => {
    const current = state.routes[teamId] ?? {};
    if (op.kind === "register") {
      return {
        ...state,
        routes: { ...state.routes, [teamId]: { ...current, [op.service]: op.url } },
      };
    }
    const { [op.service]: _removed, ...rest } = current;
    return { ...state, routes: { ...state.routes, [teamId]: rest } };
  },

  projectForTeam: (state) => ({ directory: state.routes }),
};

export default defineCoordinationPlugin(router);
