/**
 * ADR-012 Phase 5: PortalSlotProps を組み立てる純関数群。
 *
 * portal の data layer (= metadata.json glob + ParticipantProblemView) と plugin SDK の
 * shape (= PortalEndpoint / PortalPhaseEntry / PortalDisruptionEntry) の間の marshalling。
 *
 * 設計判断:
 *   - 副作用なし (= test 容易)
 *   - metadata 不在 / endpoint slot 宣言なしは空配列 (= plugin 側で `.map` で安全に処理可)
 *   - effectiveUrl は portal 側 endpoint registry (Phase 3.A) が override を返すまでは
 *     defaultUrl と同一値。 plugin から見ると "default が常に effective" になる初期 state。
 */

import type {
  PortalDisruptionEntry,
  PortalEndpoint,
  PortalPhaseEntry,
} from "@tenkacloud/portal-plugin-sdk";

interface MetadataEndpoint {
  slot: string;
  default: { from: "cfn-output"; key: string; appendPath?: string };
  overridable?: boolean;
  label?: string;
  description?: string;
}

interface MetadataPhase {
  name: string;
  afterMinutes: number;
  description?: string;
}

interface MetadataDisruption {
  id: string;
  name: string;
  defaultAfterMinutes?: number;
  description?: string;
}

/**
 * 問題の生 metadata.json を glob で持つ (= props-builder は scoring / cfnTemplate 等の
 * private field に触らず、 plugin が見ていい shape だけを取り出す)。
 */
const metadataModules = import.meta.glob<{
  default: {
    id: string;
    endpoints?: MetadataEndpoint[];
    phases?: MetadataPhase[];
    disruptions?: MetadataDisruption[];
  };
}>("../../../../problems/*/*/metadata.json", { eager: true });

function findRawMetadata(problemId: string) {
  for (const mod of Object.values(metadataModules)) {
    if (mod.default.id === problemId) return mod.default;
  }
  return undefined;
}

function joinUrl(base: string, appendPath?: string): string | undefined {
  if (!appendPath) return base;
  try {
    const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
    return new URL(appendPath, baseWithSlash).toString();
  } catch {
    return undefined;
  }
}

/**
 * `metadata.endpoints[]` + deployment.stackOutputs から PortalEndpoint[] を組み立てる。
 * overrideUrl は本 fn では未対応 (= portal の endpoint registry API を後で wire-up する)。
 */
export function buildPortalEndpointsFromOutputs(
  problemId: string,
  stackOutputs: Record<string, string>,
): readonly PortalEndpoint[] {
  const metadata = findRawMetadata(problemId);
  if (!metadata?.endpoints) return [];
  return metadata.endpoints.map((ep) => {
    const base = stackOutputs[ep.default.key];
    const defaultUrl = base ? joinUrl(base, ep.default.appendPath) : undefined;
    return {
      slot: ep.slot,
      overridable: ep.overridable === true,
      ...(ep.label ? { label: ep.label } : {}),
      ...(ep.description ? { description: ep.description } : {}),
      ...(defaultUrl ? { defaultUrl, effectiveUrl: defaultUrl } : {}),
    };
  });
}

/**
 * `metadata.phases[]` を予告用の slim shape に narrow (= effect 内部は plugin に渡さない)。
 */
export function buildPortalPhases(problemId: string): readonly PortalPhaseEntry[] {
  const metadata = findRawMetadata(problemId);
  if (!metadata?.phases) return [];
  return metadata.phases.map((p) => ({
    name: p.name,
    afterMinutes: p.afterMinutes,
    ...(p.description ? { description: p.description } : {}),
  }));
}

/**
 * `metadata.disruptions[]` を予告用の slim shape に narrow (= eventDetailType / parameters
 * 等の operator 内部 field は plugin に渡さない)。
 */
export function buildPortalDisruptions(problemId: string): readonly PortalDisruptionEntry[] {
  const metadata = findRawMetadata(problemId);
  if (!metadata?.disruptions) return [];
  return metadata.disruptions.map((d) => ({
    id: d.id,
    name: d.name,
    ...(typeof d.defaultAfterMinutes === "number"
      ? { defaultAfterMinutes: d.defaultAfterMinutes }
      : {}),
    ...(d.description ? { description: d.description } : {}),
  }));
}
