/**
 * Build-time portal plugin loader.
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
 * 別 S3 / 別 deploy からの `import(URL)` は、bundle の二重化と browser の import-map
 * 対応が未解決のため提供しない。本実装は **chunk 分割で十分** との判断 (= 50KB target も十分達成可能、 portal SPA
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
// glob pattern は Vite が build/HMR 時に解決する compile-time directive。 引数の path literal は
// ランタイムでは実行されず coverage instrument 対象として到達不能なので ignore する。
/* v8 ignore next 3 */
const pluginModules = import.meta.glob<{ default: PortalSlotComponent }>(
  "../../../../problems/*/*/portal/*.tsx",
);

/**
 * glob entry の lookup を O(1) 化する事前 index。 key は問題 dir 名 + slot path
 * (例: "microservice-migration-battle/portal/StatusPanel.tsx")。 glob で得た絶対 path から
 * 末尾 2 segment (= "<problemId>/portal/<file>.tsx") を抽出して key とする。
 *
 * 設計判断: problemId は 1 対 1 で 問題 dir 名に対応する前提 (= 慣習: dir 名 == metadata.id)。
 */
const PLUGIN_ENTRY_BY_NEEDLE: ReadonlyMap<string, () => Promise<{ default: PortalSlotComponent }>> =
  (() => {
    const map = new Map<string, () => Promise<{ default: PortalSlotComponent }>>();
    for (const [key, loader] of Object.entries(pluginModules)) {
      // key = "../../../../problems/<category>/<problemId>/portal/<file>.tsx"
      const segments = key.split("/");
      // glob は常に上記 6+ segment の portal path を返すため、 segment 数不足 / 非 portal の
      // skip 分岐は valid な glob 結果では到達不能な防御ガード。
      /* v8 ignore next */
      if (segments.length < 3) continue;
      const fileName = segments[segments.length - 1];
      const portalSegment = segments[segments.length - 2];
      const problemId = segments[segments.length - 3];
      /* v8 ignore next */
      if (!fileName || !problemId || portalSegment !== "portal") continue;
      map.set(`${problemId}/portal/${fileName}`, loader);
    }
    return map;
  })();

function resolvePluginEntry(
  problemId: string,
  slotPath: string,
): (() => Promise<{ default: PortalSlotComponent }>) | undefined {
  // slotPath は問題 dir からの相対 (例: "portal/StatusPanel.tsx")。 PLUGIN_ENTRY_BY_NEEDLE の
  // key 形式と合わせて 1 回 lookup。
  return PLUGIN_ENTRY_BY_NEEDLE.get(`${problemId}/${slotPath}`);
}

/**
 * `(problemId, slotName)` → LazyExoticComponent cache。 React.lazy() は 1 instance を
 * 同じ slot に常に渡すことで Suspense boundary の identity が安定し、 unmount→re-mount や
 * 再 Suspense fallback flash を防ぐ。 cache 不要に見えても、 React 側の lazy contract
 * (= "same component identity = same chunk") を満たすため必要。
 */
const slotComponentCache = new Map<string, LazyExoticComponent<PortalSlotComponent>>();

/**
 * `problemId` + `slotName` から plugin component を React.lazy で構築する。
 *
 * 戻り値の意味:
 * - metadata.dashboard.slots[slotName] 未宣言 → undefined (= portal 側で fallback を render)
 * - 宣言済だが file path が glob で見つからない → **erroring lazy** を返す (= deploy 漏れ
 *   / typo は配信時に observable にする。 silent skip すると config bug が露出しない)。
 *   ErrorBoundary が catch して fallback Alert を出す。
 * - load 失敗 → React.lazy が Suspense boundary 経由で error throw → ErrorBoundary で catch。
 *
 * 同一 (problemId, slotName) の戻り値は slotComponentCache で memoize されるため、 再 render
 * で同じ component identity が返る (= Suspense fallback の flash 抑止)。
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

  const cacheKey = `${problemId}::${slotName}`;
  const cached = slotComponentCache.get(cacheKey);
  if (cached) return cached;

  const loader = resolvePluginEntry(problemId, slotPath);
  const lazyComp: LazyExoticComponent<PortalSlotComponent> = loader
    ? lazy(loader)
    : lazy(() => {
        // metadata では宣言されているのに glob で見つからない (= portal/<file>.tsx の typo /
        // deploy 漏れ / file 名 mismatch)。 silent skip だと config bug が誰にも気付かれない
        // ので、 erroring lazy を返して ErrorBoundary 経由で UI に降ろす。
        // Issue #1251: warn ではなく error level で emit (= backend log ingestion / Sentry / RUM の
        // error pipeline で pick up される)。 throw も合わせて行うことで「silent fallback」を廃止。
        const msg = `[portal-plugin] unresolved slot: problemId=${problemId}, slot=${slotName}, path=${slotPath}`;
        console.error(msg);
        return Promise.reject(new Error(msg));
      });
  slotComponentCache.set(cacheKey, lazyComp);
  return lazyComp;
}

/**
 * テスト容易性 + introspection 用に glob keys を露出する。 portal 本体からは使わない。
 */
export function _listDiscoveredPluginKeys(): readonly string[] {
  return Object.keys(pluginModules);
}

/** Test 専用: slotComponentCache を clear。 portal 本体からは使わない。 */
export function _clearSlotComponentCache(): void {
  slotComponentCache.clear();
}
