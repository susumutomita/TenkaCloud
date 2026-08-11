/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `uptime-flat` (+ legacy `uptime`)
 * and `uptime-multi` scoring kinds. Extracted verbatim from scoring-metadata.ts.
 */

import { type ProgressiveHint, parseHints } from "./hints.js";
import { isPositiveNumber, optionalNonEmptyString, parseExpectedStatuses } from "./primitives.js";

export interface UptimeFlatEndpoint {
  readonly slot?: string;
  readonly outputKey?: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
  readonly pointsPerSuccess?: number;
}

export interface UptimeFlatScoringMetadata {
  /** `uptime-flat` is the new name; `uptime` is the legacy Phase 1 alias. */
  readonly kind: "uptime-flat" | "uptime";
  readonly endpoints: readonly UptimeFlatEndpoint[];
  readonly pointsPerSuccess: number;
  /** Health-check failure tick score delta. Unset = 0. Negative = penalty. */
  readonly failurePenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

export interface UptimeMultiProbedSlot {
  readonly slot: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
}

export interface UptimeMultiScoringMetadata {
  readonly kind: "uptime-multi";
  readonly probedSlots: readonly UptimeMultiProbedSlot[];
  readonly pointsAllOk: number;
  readonly failurePenalty?: number;
  /** Issue #1666: optional attack-blocked bonus (counter-delta * pointsPerBlock). */
  readonly attackBlocked?: {
    readonly slot: string;
    readonly path: string;
    readonly pointsPerBlock: number;
  };
  /** Issue #1666: optional attack-probes (scorer-side defense test). */
  readonly attackProbes?: readonly {
    readonly slot: string;
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly body?: string;
    readonly vulnerableStatus: readonly number[];
    readonly penalty: number;
    /**
     * [Issue #2422] optional non-spoiler display name surfaced to the participant portal.
     * Author-controlled; NEVER derive it from slot/path (= the exact endpoint stays hidden).
     * Trimmed and capped at 80 chars; absent → the portal numbers the probe by index.
     */
    readonly label?: string;
    /**
     * [Issue #2422] optional non-spoiler symptom line (e.g. "still returns 200 to the probe").
     * Describes the observable effect, NOT the vulnerability class or endpoint. Capped at 160 chars.
     */
    readonly symptom?: string;
  }[];
  readonly hints?: readonly ProgressiveHint[];
}

export function parseUptimeFlat(
  value: unknown,
  kindLiteral: "uptime" | "uptime-flat",
): UptimeFlatScoringMetadata | undefined {
  const u = value as {
    endpoints?: unknown;
    pointsPerSuccess?: unknown;
    failurePenalty?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.endpoints) || u.endpoints.length === 0) return undefined;
  if (typeof u.pointsPerSuccess !== "number" || u.pointsPerSuccess <= 0) return undefined;
  const endpoints = u.endpoints
    .map(parseUptimeFlatEndpoint)
    .filter((endpoint): endpoint is UptimeFlatEndpoint => endpoint !== undefined);
  if (endpoints.length === 0) return undefined;
  const hints = parseHints(u.hints);
  return {
    kind: kindLiteral,
    endpoints,
    pointsPerSuccess: u.pointsPerSuccess,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseUptimeFlatEndpoint(value: unknown): UptimeFlatEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const endpoint = value as {
    slot?: unknown;
    outputKey?: unknown;
    path?: unknown;
    expectStatus?: unknown;
    pointsPerSuccess?: unknown;
  };
  if (typeof endpoint.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(endpoint.expectStatus);
  if (!expectStatus) return undefined;
  const slot = optionalNonEmptyString(endpoint.slot);
  const outputKey = optionalNonEmptyString(endpoint.outputKey);
  if (!slot && !outputKey) return undefined;
  return {
    ...(slot ? { slot } : {}),
    ...(outputKey ? { outputKey } : {}),
    path: endpoint.path,
    expectStatus,
    ...(isPositiveNumber(endpoint.pointsPerSuccess)
      ? { pointsPerSuccess: endpoint.pointsPerSuccess }
      : {}),
  };
}

export function parseUptimeMulti(value: unknown): UptimeMultiScoringMetadata | undefined {
  const u = value as {
    probedSlots?: unknown;
    pointsAllOk?: unknown;
    failurePenalty?: unknown;
    attackBlocked?: unknown;
    attackProbes?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.probedSlots) || u.probedSlots.length === 0) return undefined;
  if (typeof u.pointsAllOk !== "number" || u.pointsAllOk <= 0) return undefined;
  const probedSlots = u.probedSlots
    .map(parseUptimeMultiSlot)
    .filter((slot): slot is UptimeMultiProbedSlot => slot !== undefined);
  if (probedSlots.length === 0) return undefined;
  const hints = parseHints(u.hints);
  const attackBlocked = parseAttackBlocked(u.attackBlocked);
  const attackProbes = Array.isArray(u.attackProbes)
    ? u.attackProbes
        .map(parseAttackProbe)
        .filter((p): p is NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] => !!p)
    : undefined;
  return {
    kind: "uptime-multi",
    probedSlots,
    pointsAllOk: u.pointsAllOk,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(attackBlocked ? { attackBlocked } : {}),
    ...(attackProbes && attackProbes.length > 0 ? { attackProbes } : {}),
    ...(hints ? { hints } : {}),
  };
}

/**
 * [Issue #2422] optional non-spoiler display string: trim, drop when blank, cap length.
 * Author-controlled portal copy — never derived from slot/path. Over-cap values are truncated
 * rather than dropped so a slightly-too-long label still renders (best-effort, non-fatal).
 */
function parseProbeDisplayString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** Issue #1666: parse one attack-probe fail-safe. slot/path/vulnerableStatus/penalty required. */
function parseAttackProbe(
  value: unknown,
): NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as {
    slot?: unknown;
    path?: unknown;
    method?: unknown;
    body?: unknown;
    vulnerableStatus?: unknown;
    penalty?: unknown;
    label?: unknown;
    symptom?: unknown;
  };
  if (typeof p.slot !== "string" || p.slot.length === 0) return undefined;
  if (typeof p.path !== "string" || p.path.length === 0) return undefined;
  if (typeof p.penalty !== "number" || p.penalty <= 0) return undefined;
  const vulnerableStatus = Array.isArray(p.vulnerableStatus)
    ? p.vulnerableStatus.filter((s): s is number => typeof s === "number")
    : [];
  if (vulnerableStatus.length === 0) return undefined;
  // [Issue #2422] author-provided non-spoiler display copy (label / symptom) for the portal.
  const label = parseProbeDisplayString(p.label, 80);
  const symptom = parseProbeDisplayString(p.symptom, 160);
  return {
    slot: p.slot,
    path: p.path,
    ...(p.method === "POST" || p.method === "GET" ? { method: p.method } : {}),
    ...(typeof p.body === "string" ? { body: p.body } : {}),
    vulnerableStatus,
    penalty: p.penalty,
    ...(label ? { label } : {}),
    ...(symptom ? { symptom } : {}),
  };
}

/** Issue #1666: attack-blocked bonus enabled only when slot/path/pointsPerBlock all present. */
function parseAttackBlocked(
  value: unknown,
): UptimeMultiScoringMetadata["attackBlocked"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const a = value as { slot?: unknown; path?: unknown; pointsPerBlock?: unknown };
  if (typeof a.slot !== "string" || a.slot.length === 0) return undefined;
  if (typeof a.path !== "string" || a.path.length === 0) return undefined;
  if (typeof a.pointsPerBlock !== "number" || a.pointsPerBlock <= 0) return undefined;
  return { slot: a.slot, path: a.path, pointsPerBlock: a.pointsPerBlock };
}

function parseUptimeMultiSlot(value: unknown): UptimeMultiProbedSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slot = value as { slot?: unknown; path?: unknown; expectStatus?: unknown };
  if (typeof slot.slot !== "string" || typeof slot.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(slot.expectStatus);
  return expectStatus ? { slot: slot.slot, path: slot.path, expectStatus } : undefined;
}
