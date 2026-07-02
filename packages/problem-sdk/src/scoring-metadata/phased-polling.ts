/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `phased-polling` scoring kind.
 * Extracted verbatim from scoring-metadata.ts.
 */

import { type ProgressiveHint, parseHints } from "./hints.js";

export interface PhasedPollingPlatformRule {
  readonly points: number;
  readonly degradedPoints?: number;
}

export interface PhasedPollingResponsePenalty {
  /** Condition DSL string. Currently only `responseTimeMs > N` (Phase 3.B). */
  readonly if: string;
  readonly points: number;
}

export interface PhasedPollingBonus {
  /** Only known bonus kind is `all-slots-on-platforms` (Phase 3.B). */
  readonly kind: string;
  readonly points: number;
  readonly once?: boolean;
  readonly platforms?: readonly string[];
}

export interface PhasedPollingScoringMetadata {
  readonly kind: "phased-polling";
  readonly intervalMinutes: number;
  readonly probe: {
    readonly metaPath: string;
    readonly scorePath: string;
    readonly posturePath?: string;
  };
  readonly platformRules: Readonly<Record<string, PhasedPollingPlatformRule>>;
  readonly failurePenalty?: number;
  readonly responsePenalties?: readonly PhasedPollingResponsePenalty[];
  readonly bonuses?: readonly PhasedPollingBonus[];
  readonly hints?: readonly ProgressiveHint[];
}

export function parsePhasedPolling(value: unknown): PhasedPollingScoringMetadata | undefined {
  const p = value as {
    intervalMinutes?: unknown;
    probe?: unknown;
    platformRules?: unknown;
    failurePenalty?: unknown;
    responsePenalties?: unknown;
    bonuses?: unknown;
    hints?: unknown;
  };
  if (typeof p.intervalMinutes !== "number" || p.intervalMinutes <= 0) return undefined;
  const probe = parsePhasedPollingProbe(p.probe);
  const platformRules = parsePlatformRules(p.platformRules);
  if (!probe) return undefined;
  if (Object.keys(platformRules).length === 0) return undefined;

  const responsePenalties = parseResponsePenalties(p.responsePenalties);
  const bonuses = parsePhasedPollingBonuses(p.bonuses);
  const hints = parseHints(p.hints);
  return {
    kind: "phased-polling",
    intervalMinutes: p.intervalMinutes,
    probe: {
      metaPath: probe.metaPath,
      scorePath: probe.scorePath,
      ...(probe.posturePath ? { posturePath: probe.posturePath } : {}),
    },
    platformRules,
    ...(typeof p.failurePenalty === "number" ? { failurePenalty: p.failurePenalty } : {}),
    ...(responsePenalties.length > 0 ? { responsePenalties } : {}),
    ...(bonuses.length > 0 ? { bonuses } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parsePhasedPollingProbe(
  value: unknown,
): PhasedPollingScoringMetadata["probe"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const probe = value as { metaPath?: unknown; scorePath?: unknown; posturePath?: unknown };
  if (typeof probe.metaPath !== "string" || typeof probe.scorePath !== "string") {
    return undefined;
  }
  if (probe.posturePath !== undefined && typeof probe.posturePath !== "string") {
    return undefined;
  }
  return {
    metaPath: probe.metaPath,
    scorePath: probe.scorePath,
    ...(probe.posturePath ? { posturePath: probe.posturePath } : {}),
  };
}

function parsePlatformRules(value: unknown): Record<string, PhasedPollingPlatformRule> {
  if (!value || typeof value !== "object") return {};
  const rules: Record<string, PhasedPollingPlatformRule> = {};
  for (const [name, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRule || typeof rawRule !== "object") continue;
    const rule = rawRule as { points?: unknown; degradedPoints?: unknown };
    if (typeof rule.points !== "number") continue;
    rules[name] = {
      points: rule.points,
      ...(typeof rule.degradedPoints === "number" ? { degradedPoints: rule.degradedPoints } : {}),
    };
  }
  return rules;
}

function parseResponsePenalties(value: unknown): PhasedPollingResponsePenalty[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const penalty = entry as { if?: unknown; points?: unknown };
      if (typeof penalty.if !== "string" || typeof penalty.points !== "number") return undefined;
      return { if: penalty.if, points: penalty.points };
    })
    .filter((penalty): penalty is PhasedPollingResponsePenalty => penalty !== undefined);
}

function parsePhasedPollingBonuses(value: unknown): PhasedPollingBonus[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parsePhasedPollingBonus)
    .filter((bonus): bonus is PhasedPollingBonus => bonus !== undefined);
}

function parsePhasedPollingBonus(value: unknown): PhasedPollingBonus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bonus = value as { kind?: unknown; points?: unknown; once?: unknown; platforms?: unknown };
  if (typeof bonus.kind !== "string" || typeof bonus.points !== "number") return undefined;
  return {
    kind: bonus.kind,
    points: bonus.points,
    ...(typeof bonus.once === "boolean" ? { once: bonus.once } : {}),
    ...(Array.isArray(bonus.platforms)
      ? {
          platforms: bonus.platforms.filter(
            (platform): platform is string => typeof platform === "string",
          ),
        }
      : {}),
  };
}
