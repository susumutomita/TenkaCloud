import type { ProblemEndpointSlot } from "../../../utils/endpoints-metadata.js";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import {
  probeUrl,
  type ProbeFn,
  type ProbeOptions,
  type ProbeResult,
} from "../../runtime-clients/http-probe-client.js";
import type { DeploymentItem } from "../deploy-handler/types.js";

export { probeUrl };
export type { ProbeFn, ProbeOptions, ProbeResult };

/** Pure scoring state shared by Lambda and the AWS-free local Simulator. */
export interface ActiveDisruptionEffect {
  readonly disruptionId: string;
  readonly points: number;
  readonly expiresAtMs: number;
}

export interface DeploymentScoringState {
  readonly bonusAwarded?: Readonly<Record<string, boolean>>;
  readonly attackCount?: number;
  readonly firedDisruptions?: readonly string[];
  readonly activeEffects?: readonly ActiveDisruptionEffect[];
}

function parseActiveEffects(raw: unknown): readonly ActiveDisruptionEffect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const effects: ActiveDisruptionEffect[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { disruptionId, points, expiresAtMs } = value as Record<string, unknown>;
    if (
      typeof disruptionId === "string" &&
      disruptionId.length > 0 &&
      typeof points === "number" &&
      Number.isFinite(points) &&
      typeof expiresAtMs === "number" &&
      Number.isFinite(expiresAtMs)
    ) {
      effects.push({ disruptionId, points, expiresAtMs });
    }
  }
  return effects.length > 0 ? effects : undefined;
}

export function parseScoringState(raw: string | undefined): DeploymentScoringState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const value = parsed as Record<string, unknown>;
  const bonusAwarded =
    value.bonusAwarded &&
    typeof value.bonusAwarded === "object" &&
    !Array.isArray(value.bonusAwarded)
      ? Object.fromEntries(
          Object.entries(value.bonusAwarded as Record<string, unknown>).filter(
            ([, enabled]) => enabled === true,
          ) as Array<[string, true]>,
        )
      : undefined;
  const attackCount = typeof value.attackCount === "number" ? value.attackCount : undefined;
  const firedDisruptions = Array.isArray(value.firedDisruptions)
    ? value.firedDisruptions.filter((item): item is string => typeof item === "string")
    : undefined;
  const activeEffects = parseActiveEffects(value.activeEffects);
  return {
    ...(bonusAwarded ? { bonusAwarded } : {}),
    ...(attackCount !== undefined ? { attackCount } : {}),
    ...(firedDisruptions && firedDisruptions.length > 0 ? { firedDisruptions } : {}),
    ...(activeEffects ? { activeEffects } : {}),
  };
}

export interface PhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
}

export function resolveActivePhase(
  phases: readonly PhaseEntry[],
  elapsedMin: number,
): PhaseEntry | undefined {
  const sorted = [...phases].sort((a, b) => a.afterMinutes - b.afterMinutes);
  let active: PhaseEntry | undefined;
  for (const phase of sorted) {
    if (elapsedMin >= phase.afterMinutes) active = phase;
  }
  return active;
}

export function joinUrl(base: string, relativePath: string): string {
  if (!relativePath) return base;
  try {
    return new URL(relativePath).toString();
  } catch {
    const baseTrimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    const pathTrimmed = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
    return `${baseTrimmed}/${pathTrimmed}`;
  }
}

export interface KindScoreEvent {
  readonly source: "uptime" | "flag" | "attack-detected";
  readonly points: number;
  readonly occurredAt: string;
}

export interface KindResult {
  readonly scoreDelta: number;
  readonly scoreEvents: readonly KindScoreEvent[];
  readonly endpointsHealthJson?: string;
  readonly attackProbesJson?: string;
  readonly postureJson?: string;
  readonly platform?: string;
  readonly newState?: DeploymentScoringState;
  readonly attackDetected?: boolean;
  readonly lastResult?: "ok" | "fail";
}

export function uptimeEvent(points: number, occurredAt: string): KindScoreEvent {
  return { source: "uptime", points, occurredAt };
}

export function noopKindResult(): KindResult {
  return { scoreDelta: 0, scoreEvents: [] };
}

export interface AttackProbeRequest {
  readonly slot: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}

export type AttackProbeFn = (request: AttackProbeRequest) => Promise<ProbeResult>;

export interface AuthoritativeEndpointPlacement {
  readonly slot: string;
  readonly effectiveUrl: string;
  readonly verifiedPlatform: string;
}

export interface KindHandlerInput<S extends ProblemScoringMetadata = ProblemScoringMetadata> {
  readonly deployment: Partial<DeploymentItem>;
  readonly scoring: S;
  readonly slots: readonly ProblemEndpointSlot[];
  readonly overrides: readonly { readonly slot: string; readonly overrideUrl: string }[];
  readonly phases: readonly PhaseEntry[];
  readonly nowMs: number;
  readonly nowIso: string;
  readonly prevState: DeploymentScoringState;
  readonly probe?: ProbeFn;
  readonly attackProbe?: AttackProbeFn;
  readonly authoritativeEndpointPlacements?: readonly AuthoritativeEndpointPlacement[];
}
