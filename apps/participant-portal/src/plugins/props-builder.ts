/**
 * ADR-012 Phase 5: PortalSlotProps を組み立てる純関数群。
 *
 * `data/problems.ts` の build-time catalog (= operator 内部 field を narrow 済) を消費し、
 * deployment.stackOutputs / team view と合流して SDK の shape に marshal する。
 *
 * 設計判断:
 *   - 副作用なし (= test 容易)
 *   - metadata 不在 / endpoint slot 宣言なしは空配列 (= plugin 側で `.map` で安全に処理可)
 *   - URL 結合失敗は context (problemId / slot / key) 付きで throw (= silent skip しない)
 *   - effectiveUrl は portal 側 endpoint registry (Phase 3.A) が override を返すまでは
 *     defaultUrl と同一値。 plugin から見ると "default が常に effective" になる初期 state。
 */

import type {
  PortalDisruptionEntry,
  PortalEndpoint,
  PortalPhaseEntry,
  PortalSlotProps,
} from "@tenkacloud/portal-plugin-sdk";
import { findProblemMetadata } from "../data/problems";

/**
 * `base` + 任意 `appendPath` を結合して absolute URL を返す。 不正な URL は throw
 * (= silent undefined fallback は metadata / CFn output の malformed を隠す。 caller の
 * `buildPortalEndpointsFromOutputs` で context 付き Error に rethrow する)。
 */
function joinUrl(base: string, appendPath?: string): string {
  if (!appendPath) return base;
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  return new URL(appendPath, baseWithSlash).toString();
}

/**
 * `metadata.endpoints[]` + deployment.stackOutputs から PortalEndpoint[] を組み立てる。
 * overrideUrl は本 fn では未対応 (= portal の endpoint registry API を後で wire-up する)。
 * URL 結合失敗時は context 付きで throw (= caller の ErrorBoundary に降ろす)。
 */
export function buildPortalEndpointsFromOutputs(
  problemId: string,
  stackOutputs: Record<string, string>,
): readonly PortalEndpoint[] {
  const metadata = findProblemMetadata(problemId);
  if (!metadata || metadata.endpoints.length === 0) return [];
  return metadata.endpoints.map((ep) => {
    const base = stackOutputs[ep.default.key];
    let defaultUrl: string | undefined;
    if (base) {
      try {
        defaultUrl = joinUrl(base, ep.default.appendPath);
      } catch (e) {
        throw new Error(
          `Failed to build endpoint URL for problemId=${problemId} slot=${ep.slot} key=${ep.default.key}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    }
    return {
      slot: ep.slot,
      overridable: ep.overridable,
      ...(ep.label ? { label: ep.label } : {}),
      ...(ep.description ? { description: ep.description } : {}),
      ...(defaultUrl ? { defaultUrl, effectiveUrl: defaultUrl } : {}),
    };
  });
}

/**
 * Issue #689 (= ADR-013 OQ#7): 競技者にとって発見すべき phase / disruption 詳細を
 * 事前にネタバレ表示しないため、 各 entry が `publicHint=true` を持つ場合のみ portal に
 * 流す。 default は **hide** (= fail-closed)、 operator side (= admin-console) は別経路で
 * 全 phase 表示できる前提。 metadata 作者が「これは事前に見せて OK」 と明示した entry だけが
 * portal の StatusPanel に届く。
 */
export function buildPortalPhases(problemId: string): readonly PortalPhaseEntry[] {
  const phases = findProblemMetadata(problemId)?.phases ?? [];
  return phases.filter((p) => p.publicHint === true);
}

export function buildPortalDisruptions(problemId: string): readonly PortalDisruptionEntry[] {
  const disruptions = findProblemMetadata(problemId)?.disruptions ?? [];
  return disruptions.filter((d) => d.publicHint === true);
}

/**
 * portal の `view.team` shape を SDK の team shape に narrow。 undefined field を落として
 * `exactOptionalPropertyTypes` に適合させる。 PortalPluginSlots / ProblemDetail の重複を
 * 1 箇所に集約。
 */
export function buildPortalTeam(team: {
  readonly teamName: string;
  readonly teamId?: string;
  readonly eventId?: string;
}): PortalSlotProps["team"] {
  return {
    teamName: team.teamName,
    ...(team.teamId ? { teamId: team.teamId } : {}),
    ...(team.eventId ? { eventId: team.eventId } : {}),
  };
}
