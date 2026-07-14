import { StatusCodes } from "http-status-codes";
import type { ProblemEndpointSlot } from "../../../utils/endpoints-metadata.js";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { isSsrfSafeUrl } from "../shared/ssrf-guard.js";

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

export interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly responseTimeMs: number;
  readonly body?: string;
}

export interface ProbeOptions {
  readonly expectStatus?: readonly number[];
  readonly timeoutMs?: number;
  readonly readBody?: boolean;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}

export type ProbeFn = (url: string, options?: ProbeOptions) => Promise<ProbeResult>;

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 4_096;

export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  if (!isSsrfSafeUrl(url)) {
    clearTimeout(timer);
    return { ok: false, status: undefined, responseTimeMs: Date.now() - startedAt };
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
      ...(options.method === "POST" && options.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: options.body }
        : {}),
    });
    const responseTimeMs = Date.now() - startedAt;
    const finalUrl = response.url;
    const safeFinal = !finalUrl || isSsrfSafeUrl(finalUrl);
    const ok =
      safeFinal &&
      (options.expectStatus
        ? options.expectStatus.includes(response.status)
        : response.status >= StatusCodes.OK && response.status < StatusCodes.MULTIPLE_CHOICES);
    const body =
      options.readBody && ok ? await readCappedBody(response, MAX_BODY_BYTES) : undefined;
    return {
      ok,
      status: response.status,
      responseTimeMs,
      ...(body !== undefined ? { body } : {}),
    };
  } catch {
    return { ok: false, status: undefined, responseTimeMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function readCappedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  try {
    const stream = response.body;
    if (stream && typeof stream.getReader === "function") {
      const bytes = await drainStreamCapped(stream.getReader(), maxBytes);
      return new TextDecoder().decode(bytes);
    }
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return undefined;
  }
}

async function drainStreamCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.length > maxBytes ? merged.subarray(0, maxBytes) : merged;
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
