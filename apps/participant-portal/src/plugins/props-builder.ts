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
 *   - `buildPortalEndpointsFromOutputs` は CFn stackOutputs だけを見る override 非対応の経路で、
 *     `effectiveUrl` は常に `defaultUrl` と同一。default URL が空になりうる問題では override が
 *     反映されないため、[Issue #2661] 以降 ProblemDetail は server 集約の `buildPortalEndpointsFromServer`
 *     を優先し、この fn は server endpoints 未取得時の fallback に降格した。
 */

import type {
  PortalCoordinationEntry,
  PortalDisruptionEntry,
  PortalEndpoint,
  PortalPhaseEntry,
  PortalSlotProps,
} from "@tenkacloud/portal-plugin-sdk";
import { toErrorMessage } from "@tenkacloud/web-kit";
import type { ParticipantEndpointView } from "../api/portal-client";
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
 * `metadata.endpoints[]` + deployment.stackOutputs から PortalEndpoint[] を組み立てる **fallback**。
 * override は見ない (stackOutputs のみ)。override を反映するには server 集約の
 * `buildPortalEndpointsFromServer` を使う ([Issue #2661])。この fn は server endpoints が
 * まだ取得できていない初期 render 用。URL 結合失敗時は context 付きで throw (= caller の ErrorBoundary に降ろす)。
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
        // `new URL()` は不正入力に対して必ず TypeError (= instanceof Error) を投げるため、
        // String(e) 側は到達不能な防御 fallback。 分岐 coverage 上ノイズになるので ignore。
        /* v8 ignore start */
        const detail = toErrorMessage(e);
        /* v8 ignore stop */
        throw new Error(
          `Failed to build endpoint URL for problemId=${problemId} slot=${ep.slot} key=${ep.default.key}: ${detail}`,
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
 * [Issue #2661] server (`listProblemEndpoints`) が返す `ParticipantEndpointView[]` を
 * plugin SDK の `PortalEndpoint[]` に marshal する。server 側で override をマージ済なので、
 * `buildPortalEndpointsFromOutputs` (= CFn stackOutputs のみ、override 非対応) と違い、
 * default URL が空の override 前提問題でも `effectiveUrl` / `overrideUrl` が正しく入る。
 * `defaultKey` は plugin 契約に無いので落とし、undefined field は exactOptionalPropertyTypes の
 * ために conditional spread で除く。
 */
export function buildPortalEndpointsFromServer(
  endpoints: readonly ParticipantEndpointView[],
): readonly PortalEndpoint[] {
  return endpoints.map((ep) => ({
    slot: ep.slot,
    overridable: ep.overridable,
    ...(ep.label ? { label: ep.label } : {}),
    ...(ep.description ? { description: ep.description } : {}),
    ...(ep.defaultUrl ? { defaultUrl: ep.defaultUrl } : {}),
    ...(ep.overrideUrl ? { overrideUrl: ep.overrideUrl } : {}),
    ...(ep.effectiveUrl ? { effectiveUrl: ep.effectiveUrl } : {}),
  }));
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
 * ADR-028 / Issue #1420: 参加者間 coordination の公開情報を plugin props 用に取り出す。
 * catalog 側 `metadataToEntry` が既に `publicHint === true` で narrow 済 (= non-public は
 * entry 自体が無い)ので、 ここは catalog の値をそのまま返す。 未宣言 problem は undefined。
 */
export function buildPortalCoordination(problemId: string): PortalCoordinationEntry | undefined {
  return findProblemMetadata(problemId)?.interTeamCoordination;
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
