/**
 * PortalSlotProps を組み立てる純関数群。
 *
 * `data/problems.ts` の build-time catalog (= operator 内部 field を narrow 済) を消費し、
 * deployment.stackOutputs / team view と合流して SDK の shape に marshal する。
 *
 * 設計判断:
 *   - 副作用なし (= test 容易)
 *   - metadata 不在 / endpoint slot 宣言なしは空配列 (= plugin 側で `.map` で安全に処理可)
 *   - URL 結合失敗は context (problemId / slot / key) 付きで throw (= silent skip しない)
 *   - effectiveUrl は portal 側 endpoint registry が override を返すまでは
 *     defaultUrl と同一値。 plugin から見ると "default が常に effective" になる初期 state。
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
 * `metadata.endpoints[]` + deployment.stackOutputs から PortalEndpoint[] を組み立てる。
 * Endpoint registry を取得できない間・取得失敗時だけ使う fallback。registry 成功後は
 * {@link buildPortalEndpointsFromRegistry} が server-side の effective URL を正とする。
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

/** Narrows the server endpoint registry response to the public plugin SDK contract. */
export function buildPortalEndpointsFromRegistry(
  endpoints: readonly ParticipantEndpointView[],
): readonly PortalEndpoint[] {
  return endpoints.map(({ defaultKey: _defaultKey, ...endpoint }) => endpoint);
}

/**
 * Issue #689: 競技者にとって発見すべき phase / disruption 詳細を
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
 * Issue #1420: 参加者間 coordination の公開情報を plugin props 用に取り出す。
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
