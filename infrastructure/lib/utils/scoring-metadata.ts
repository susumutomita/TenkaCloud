/**
 * 問題の `metadata.json:scoring` section の type-safe な parser。
 *
 * 同じ shape を CDK synth 時 (`discoverProblemsScoring`) と Lambda runtime
 * (Portal `submit-flag`、HealthCheck `health-check-handler`、`lookup.toView`) の
 * 両方で参照するため、ここに 1 箇所に集約する。SCHEMA.json と整合させる。
 */

export type ProblemScoringMetadata =
  | {
      kind: "flag";
      flagOutputKey: string;
      points: number;
      hints?: readonly string[];
    }
  | {
      kind: "uptime";
      endpoints: readonly { outputKey: string; path: string; expectStatus: readonly number[] }[];
      pointsPerSuccess: number;
    };

/** 1 件の `scoring` value を ProblemScoringMetadata に narrow する。不正なら undefined。 */
export function parseScoringMetadata(value: unknown): ProblemScoringMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") {
    const f = value as { flagOutputKey?: unknown; points?: unknown; hints?: unknown };
    if (
      typeof f.flagOutputKey === "string" &&
      typeof f.points === "number" &&
      Number.isFinite(f.points) &&
      f.points > 0
    ) {
      return {
        kind: "flag",
        flagOutputKey: f.flagOutputKey,
        points: f.points,
        hints: Array.isArray(f.hints)
          ? (f.hints.filter((h) => typeof h === "string") as string[])
          : undefined,
      };
    }
  }
  if (v.kind === "uptime") {
    const u = value as { endpoints?: unknown; pointsPerSuccess?: unknown };
    if (Array.isArray(u.endpoints) && typeof u.pointsPerSuccess === "number") {
      return {
        kind: "uptime",
        endpoints: u.endpoints as ProblemScoringMetadata extends {
          kind: "uptime";
          endpoints: infer E;
        }
          ? E
          : never,
        pointsPerSuccess: u.pointsPerSuccess,
      };
    }
  }
  return undefined;
}

/**
 * Lambda env (`BATTLE_PROBLEMS_SCORING`) を decode し、`{ [problemId]: ProblemScoringMetadata }`
 * に narrow する。不正な entry (parse 失敗 / non-object / shape mismatch) は drop。
 */
export function parseScoringEnv(raw: string | undefined): Record<string, ProblemScoringMetadata> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ProblemScoringMetadata> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const cfg = parseScoringMetadata(v);
    if (cfg) out[k] = cfg;
  }
  return out;
}
