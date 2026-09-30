import type { ProblemEndpointSlot, ProblemScoringMetadata } from "@tenkacloud/problem-sdk/internal";
import type { DeploymentScoringState } from "./deployment-scoring-state";
import type { ProbeFn, ProbeResult } from "./http-probe-client";

export interface ScoringDeployment {
  readonly problemId?: string;
  readonly createdAt?: string;
  readonly stackOutputs?: string;
  readonly endpointsHealth?: string;
  readonly lastResult?: "ok" | "fail";
}

export interface PhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
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
  readonly deployment: ScoringDeployment;
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
