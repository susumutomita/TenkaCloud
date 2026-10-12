/** Public declaration contract owned by TenkaCloudChallenge#906. No grader or answer fields. */
export interface SkillDeclaration {
  readonly skillId: string;
  readonly label: string;
  readonly i18n: { readonly en: { readonly label: string } };
  readonly rule: { readonly source: "flag" | "uptime"; readonly result: "ok" };
}

export interface SkillCatalogSnapshot {
  readonly revision: string;
  readonly scoringKind: string;
  readonly declarations: readonly SkillDeclaration[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && /\S/u.test(value);
}

/** Reconstruct an allowlisted DTO; malformed/legacy declarations never reach exports. */
export function skillDeclarations(value: unknown): readonly SkillDeclaration[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  const declarations: SkillDeclaration[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = record(raw);
    const rule = record(entry?.rule);
    const i18n = record(entry?.i18n);
    const en = record(i18n?.en);
    if (
      !entry ||
      !keys(entry, ["skillId", "label", "i18n", "rule"]) ||
      typeof entry.skillId !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(entry.skillId) ||
      seen.has(entry.skillId) ||
      !label(entry.label) ||
      !i18n ||
      !keys(i18n, ["en"]) ||
      !en ||
      !keys(en, ["label"]) ||
      !label(en.label) ||
      !rule ||
      !keys(rule, ["source", "result"]) ||
      (rule.source !== "flag" && rule.source !== "uptime") ||
      rule.result !== "ok"
    )
      return undefined;
    seen.add(entry.skillId);
    declarations.push({
      skillId: entry.skillId,
      label: entry.label,
      i18n: { en: { label: en.label } },
      rule: { source: rule.source, result: "ok" },
    });
  }
  return declarations;
}

/**
 * The scoring classification an event retains for evaluation. uptime-multi attack scoring
 * (`attackBlocked` bonuses and `attackProbes` penalties) writes positive or negative `uptime`
 * rows that are not health probe outcomes, so those problems keep a kind no rule can assess.
 */
export function skillScoringKind(scoring: unknown): string {
  const value = record(scoring);
  const kind = typeof value?.kind === "string" ? value.kind : "unknown";
  const attackScoring = value?.attackBlocked !== undefined || value?.attackProbes !== undefined;
  return kind === "uptime-multi" && attackScoring ? "uptime-multi+attack-scoring" : kind;
}

export function assessableSource(kind: string, source: string): boolean {
  return source === "flag"
    ? kind === "flag" || kind === "verify"
    : source === "uptime" && ["uptime", "uptime-flat", "uptime-multi"].includes(kind);
}
