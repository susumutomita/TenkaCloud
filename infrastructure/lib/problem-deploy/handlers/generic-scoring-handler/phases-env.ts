import { decodeLargeEnvValue } from "../../../utils/env-encoding.js";
import type { PhaseEntry } from "./shared.js";

/**
 * `BATTLE_PROBLEMS_PHASES` env を decode (= `{ [problemId]: PhaseEntry[] }`)。
 * 不正 entry は drop、 値が無ければ空 map。
 */
export function parsePhasesEnv(raw: string | undefined): Record<string, readonly PhaseEntry[]> {
  const decoded = decodeLargeEnvValue(raw);
  if (!decoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsePhasesMap(parsed as Record<string, unknown>);
}

function parsePhasesMap(parsed: Record<string, unknown>): Record<string, readonly PhaseEntry[]> {
  const out: Record<string, readonly PhaseEntry[]> = {};
  for (const [problemId, value] of Object.entries(parsed)) {
    const phases = parsePhaseEntries(value);
    if (phases.length > 0) out[problemId] = phases;
  }
  return out;
}

function parsePhaseEntries(value: unknown): PhaseEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(parsePhaseEntry).filter((phase): phase is PhaseEntry => phase !== undefined);
}

function parsePhaseEntry(value: unknown): PhaseEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const phase = value as { name?: unknown; afterMinutes?: unknown; effect?: unknown };
  if (typeof phase.name !== "string" || typeof phase.afterMinutes !== "number") return undefined;
  const effect = parsePhaseEffect(phase.effect);
  return {
    name: phase.name,
    afterMinutes: phase.afterMinutes,
    ...(effect ? { effect } : {}),
  };
}

function parsePhaseEffect(value: unknown): PhaseEntry["effect"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const effect = value as Record<string, unknown>;
  return {
    ...(typeof effect.scorePathOverride === "string"
      ? { scorePathOverride: effect.scorePathOverride }
      : {}),
    ...(Array.isArray(effect.switchPlatformToDegraded)
      ? {
          switchPlatformToDegraded: effect.switchPlatformToDegraded.filter(
            (platform): platform is string => typeof platform === "string",
          ),
        }
      : {}),
  };
}
