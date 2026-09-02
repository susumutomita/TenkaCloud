import type { CoordinationContext, CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";
import {
  type CoordinationDispatchInput,
  type CoordinationDispatchOutcome,
  type CoordinationProjectionOutcome,
  dispatchCoordinationOp,
  projectCoordinationForTeam,
} from "./coordination-dispatch.js";
import { pluginStateSchemaVersion } from "./coordination-state-schema.js";
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
 * value が {@link CoordinationPlugin} の **必須 hook** (initialState + 3 hook) を持つか構造判定する。
 * tick は optional なので問わない。 動的 load した未知 module を dispatcher に渡す前の門番。
 *
 * `stateSchemaVersion` / `migrateState` の妥当性はここでは見ない --
 * [Issue #3150] Codex review: 版宣言の違反を「plugin が無い」と同じ false に潰すと、
 * caller がこの 2 つを区別できず、 projection は 200 fallback で静かに返り、 tick は TTL を
 * 延ばさないまま進行中の行を retention で失う。 版の判定は
 * {@link coordinationPluginSchemaDefect} が理由付きで返す。
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
 * [Issue #3150] ここが「deploy が落ちる」の実現点。 synth / activation は plugin を実行しない
 * (#3154 の境界判断) ので、 pack-author コードを安全に評価できる最初の点がこの loader。
 *
 * 契約違反なら運営の log に載せる 1 行を返し、 満たしていれば null:
 *   - `stateSchemaVersion` を宣言するなら正の整数でなければ拒否
 *   - `stateSchemaVersion` が 2 以上なのに `migrateState` が function でなければ拒否
 *   - `migrateState` を宣言するなら function でなければ拒否 (版に関係なく)
 */
export function coordinationPluginSchemaDefect(
  plugin: CoordinationPlugin<unknown, unknown>,
): string | null {
  const p = plugin as unknown as Record<string, unknown>;
  if (p.stateSchemaVersion !== undefined) {
    if (
      typeof p.stateSchemaVersion !== "number" ||
      !Number.isInteger(p.stateSchemaVersion) ||
      p.stateSchemaVersion <= 0
    ) {
      return `stateSchemaVersion must be a positive integer, got ${JSON.stringify(p.stateSchemaVersion)}`;
    }
  }
  if (p.migrateState !== undefined && typeof p.migrateState !== "function") {
    return "migrateState must be a function when declared";
  }
  const declared = pluginStateSchemaVersion(plugin);
  if (declared >= 2 && typeof p.migrateState !== "function") {
    return `stateSchemaVersion ${declared} requires migrateState`;
  }
  return null;
}

/**
 * plugin の load 結果。 [Issue #3150] Codex review の要点は
 * **`unavailable` と `invalid_schema` を分ける**ことにある:
 *   - `unavailable` — bundle 不在 / import 失敗 / 必須 hook 欠落。 問題が coordination 未対応か
 *     壊れている。 従来どおり安全な既定 (projection は fallback の 200) に倒す。
 *   - `invalid_schema` — plugin は在るが版の宣言が契約違反。 運営が直せる deploy 事故なので
 *     3 経路すべてで可視化し、 かつ進行中の行を巻き添えにしない。
 */
export type CoordinationPluginLoad =
  | { readonly kind: "ok"; readonly plugin: CoordinationPlugin<unknown, unknown> }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid_schema"; readonly detail: string };

/**
 * plugin module を動的 import し、 default export (無ければ module 自体) を契約に照らす。
 * import 失敗 (= module 不在 / 構文エラー) と必須 hook の欠落は `unavailable`、
 * 版宣言の違反は理由付きの `invalid_schema`。 platform は問題依存の意味論を持たないので、
 * buggy / 未対応な問題でも participant API 全体は壊さない。
 */
export async function loadCoordinationPlugin(
  importer: PluginImporter,
  moduleRef: string,
): Promise<CoordinationPluginLoad> {
  let mod: unknown;
  try {
    mod = await importer(moduleRef);
  } catch {
    return { kind: "unavailable" };
  }
  const candidate = (mod as { default?: unknown } | null)?.default ?? mod;
  if (!isCoordinationPlugin(candidate)) return { kind: "unavailable" };
  const defect = coordinationPluginSchemaDefect(candidate);
  return defect === null
    ? { kind: "ok", plugin: candidate }
    : { kind: "invalid_schema", detail: defect };
}

/** plugin が load できなかった (= 問題が coordination 未対応 / 壊れている) ときの outcome。 */
export type PluginUnavailable = { readonly kind: "plugin_unavailable" };

/**
 * plugin の動的 load と `dispatchOp` を 1 経路にまとめた orchestration。
 * plugin が load できなければ `plugin_unavailable`、 版宣言が壊れていれば `schema_mismatch`
 * (どちらも 503)。 いずれも副作用 (DDB) には触れない。
 */
export async function loadAndDispatchCoordinationOp(
  importer: PluginImporter,
  moduleRef: string,
  store: CoordinationStoreDeps,
  input: CoordinationDispatchInput<unknown>,
): Promise<CoordinationDispatchOutcome | PluginUnavailable> {
  const load = await loadCoordinationPlugin(importer, moduleRef);
  if (load.kind === "unavailable") return { kind: "plugin_unavailable" };
  if (load.kind === "invalid_schema") {
    return { kind: "schema_mismatch", reason: "invalid_plugin_schema", detail: load.detail };
  }
  return dispatchCoordinationOp(store, load.plugin, input);
}

/**
 * 動的 load → projection の read 経路 (書き込みなし、 portal polling 用)。 plugin が load できなければ
 * `{ kind: "ok", projection: fallbackProjection }` を返す (= 他 team の機密を出さない安全な既定。
 * 挙動は #3150 以前と不変)。
 *
 * [Issue #3150] Codex review: ただし **版宣言が壊れた plugin をこの fallback に混ぜない**。
 * projection は portal がいちばん頻繁に叩く経路なので、 ここで 200 を返すと壊れた deploy が
 * 「空だが正常な板」として無期限に見え続け、 503 は op を投げた参加者にしか出ない。
 */
export async function loadAndProjectCoordinationForTeam(
  importer: PluginImporter,
  moduleRef: string,
  store: CoordinationStoreDeps,
  input: {
    readonly scope: CoordinationStateScope;
    readonly teamId: string;
    readonly ctx: CoordinationContext;
    readonly fallbackProjection: unknown;
  },
): Promise<CoordinationProjectionOutcome> {
  const load = await loadCoordinationPlugin(importer, moduleRef);
  if (load.kind === "unavailable") return { kind: "ok", projection: input.fallbackProjection };
  if (load.kind === "invalid_schema") {
    return { kind: "schema_mismatch", reason: "invalid_plugin_schema", detail: load.detail };
  }
  return projectCoordinationForTeam(store, load.plugin, input);
}
