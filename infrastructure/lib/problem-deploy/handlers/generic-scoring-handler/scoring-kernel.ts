import type {
  ActiveDisruptionEffect,
  DeploymentScoringState,
} from "../../../../../scripts/lib/deployment-scoring-state";
import type { PhaseEntry } from "../../../../../scripts/lib/scoring-common";

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
