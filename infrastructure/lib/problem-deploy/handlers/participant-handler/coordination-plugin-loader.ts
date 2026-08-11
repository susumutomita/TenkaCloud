import type { CoordinationContext, CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import {
  type CoordinationDispatchInput,
  type CoordinationDispatchOutcome,
  dispatchCoordinationOp,
  projectCoordinationForTeam,
} from "./coordination-dispatch.js";
import type { CoordinationStoreDeps } from "./coordination-store.js";

/**
 * Issue #1420: 問題が同梱する coordination plugin の **動的 import loader**。
 *
 * 静的レジストリにすると platform が各問題に結合し、 community が coordination 付き問題を
 * 追加するたびに platform の再デプロイが要る。 それは「問題は plugin、 platform は host」を壊し
 * 問題カタログの community moat を殺す。 そこで plugin は問題 payload (配信経路) から
 * 取得し runtime に `import()` で動的 load する — platform リリース不要で community が拡張できる。
 *
 * 実 import 関数は {@link PluginImporter} として注入する (= 本番は S3 から materialize した module を
 * import、 test は fake)。 別 isolate sandbox は立てない (cost/複雑度): plugin の hook は
 * SDK 契約上すべて純関数 (AWS SDK / fetch 非依存) で、 bug は当該 event の 1 row に閉じ
 * (optimistic lock + DDB write fail で停止)、 platform 全体には波及しない。
 */

/** plugin module を解決する関数。 本番は S3 payload を materialize した module ref を import()。 */
export type PluginImporter = (moduleRef: string) => Promise<unknown>;

/**
 * value が {@link CoordinationPlugin} 契約 (initialState + 3 必須 hook) を満たすか構造判定する。
 * tick は optional なので問わない。 動的 load した未知 module を dispatcher に渡す前の門番。
 */
export function isCoordinationPlugin(
  value: unknown,
): value is CoordinationPlugin<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.initialState === "function" &&
    typeof p.validateOp === "function" &&
    typeof p.applyOp === "function" &&
    typeof p.projectForTeam === "function"
  );
}

/**
 * plugin module を動的 import し、 default export (無ければ module 自体) が契約を満たせば返す。
 * import 失敗 (= module 不在 / 構文エラー) や契約不一致は **null** を返す (= caller が safe fallback)。
 * platform は問題依存の意味論を持たないので、 buggy / 未対応な問題でも participant API を壊さない。
 */
export async function loadCoordinationPlugin(
  importer: PluginImporter,
  moduleRef: string,
): Promise<CoordinationPlugin<unknown, unknown> | null> {
  let mod: unknown;
  try {
    mod = await importer(moduleRef);
  } catch {
    return null;
  }
  const candidate = (mod as { default?: unknown } | null)?.default ?? mod;
  return isCoordinationPlugin(candidate) ? candidate : null;
}

/** plugin が load できなかった (= 問題が coordination 未対応 / 壊れている) ときの outcome。 */
export type PluginUnavailable = { readonly kind: "plugin_unavailable" };

/**
 * plugin の動的 load と `dispatchOp` を 1 経路にまとめた orchestration。
 * plugin が load できなければ `plugin_unavailable` を返し、 副作用 (DDB) には触れない。
 */
export async function loadAndDispatchCoordinationOp(
  importer: PluginImporter,
  moduleRef: string,
  store: CoordinationStoreDeps,
  input: CoordinationDispatchInput<unknown>,
): Promise<CoordinationDispatchOutcome | PluginUnavailable> {
  const plugin = await loadCoordinationPlugin(importer, moduleRef);
  if (!plugin) return { kind: "plugin_unavailable" };
  return dispatchCoordinationOp(store, plugin, input);
}

/**
 * 動的 load → projection の read 経路 (書き込みなし、 portal polling 用)。 plugin が load できなければ
 * `fallbackProjection` を返す (= 他 team の機密を出さない安全な既定)。
 */
export async function loadAndProjectCoordinationForTeam(
  importer: PluginImporter,
  moduleRef: string,
  store: CoordinationStoreDeps,
  input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly teamId: string;
    readonly ctx: CoordinationContext;
    readonly fallbackProjection: unknown;
  },
): Promise<unknown> {
  const plugin = await loadCoordinationPlugin(importer, moduleRef);
  if (!plugin) return input.fallbackProjection;
  return projectCoordinationForTeam(store, plugin, input);
}
