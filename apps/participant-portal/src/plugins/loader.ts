/**
 * ADR-012 Phase 5 plugin loader.
 *
 * MVP は **build-time integration via Vite import.meta.glob** で動作する:
 *
 * 1. Vite が build 時に `problems/<id>/portal/*.tsx` を discover し、 各 file を
 *    別 chunk として bundle に組み込む (= `eager: false` で lazy chunk 分割)。
 * 2. portal は `loadPluginSlot(problemId, slotName)` で metadata.dashboard.slots の
 *    file path を引き、 該当 chunk を `React.lazy()` に渡して動的 load する。
 * 3. plugin 不在 / load 失敗 / 該当 slot 未宣言なら `null` を返し、 portal 側で
 *    fallback (= 標準 panel) を render する。
 *
 * 真の runtime URL-based loading (= 別 S3 / 別 deploy / `@vite-ignore` 付き `import(URL)`)
 * は Phase 7 separate ADR で扱う (= bundle 二重化問題 + importmap browser support 等)。
 * 本 MVP は **chunk 分割で十分** との判断 (= 50KB target も十分達成可能、 portal SPA
 * 起動時 cost にはほぼ影響しない)。
 */

import type { PortalSlotComponent, PortalSlotName } from "@tenkacloud/portal-plugin-sdk";
import { type LazyExoticComponent, lazy } from "react";
import { findProblemMetadata, type ProblemDashboardSlots } from "../data/problems";

/**
 * Vite glob discovery: `problems/<category>/<id>/portal/<SlotName>.tsx`。
 * `eager: false` で各 file を別 chunk に分け、 必要時のみ fetch される。
 * 戻り値 key の例: "../../../../problems/battles/microservice-migration-battle/portal/StatusPanel.tsx"
 */
const pluginModules = import.meta.glob<{ default: PortalSlotComponent }>(
  "../../../../problems/*/*/portal/*.tsx",
);

/**
 * metadata.json の `dashboard.slots[slotName] = "portal/<file>.tsx"` を、 vite glob の
 * key (= `<projectRoot>/problems/<category>/<id>/portal/<file>.tsx` の portal 相対) に
 * 変換するヘルパー。
 *
 * 戻り値: matched なら glob entry の loader、 無ければ undefined。
 */
function resolvePluginEntry(
  problemId: string,
  slotPath: string,
): (() => Promise<{ default: PortalSlotComponent }>) | undefined {
  // metadata の slotPath は問題 dir からの相対 (例: "portal/StatusPanel.tsx")。
  // glob key は portal SPA src/plugins/loader.ts からの相対 (例: "../../../../problems/...")。
  // problemId は 1 対 1 で 問題 dir 名に対応する前提 (= 慣習: dir 名 == metadata.id)。
  const needle = `/${problemId}/${slotPath}`;
  for (const [key, loader] of Object.entries(pluginModules)) {
    if (key.endsWith(needle)) return loader;
  }
  return undefined;
}

/**
 * `problemId` + `slotName` から plugin component を React.lazy で構築する。
 *
 * - metadata.dashboard.slots[slotName] が無い → undefined (portal 側で fallback)
 * - file path が glob で見つからない → undefined (= deploy 漏れ / typo)
 * - load 失敗 → React.lazy が Suspense boundary 経由で error throw (= ErrorBoundary で catch)
 *
 * 同一 (problemId, slotName) は memoize される (= Vite chunk は 1 度 fetch されたら cache)。
 */
export function loadPluginSlot(
  problemId: string,
  slotName: PortalSlotName,
): LazyExoticComponent<PortalSlotComponent> | undefined {
  const metadata = findProblemMetadata(problemId);
  if (!metadata) return undefined;
  const slots: ProblemDashboardSlots | undefined = metadata.dashboardSlots;
  const slotPath = slots?.[slotName];
  if (!slotPath) return undefined;
  const loader = resolvePluginEntry(problemId, slotPath);
  if (!loader) return undefined;
  return lazy(loader);
}

/**
 * テスト容易性 + introspection 用に glob keys を露出する。 portal 本体からは使わない。
 */
export function _listDiscoveredPluginKeys(): readonly string[] {
  return Object.keys(pluginModules);
}
