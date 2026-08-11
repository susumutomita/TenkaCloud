/**
 * @tenkacloud/web-kit feature flags: one shared, typed mechanism so experimental
 * features can ship behind a switch without scattering `config.featureX` booleans (spaghetti).
 *
 * The contract, per app:
 *   1. Declare every flag once in the app's `FEATURE_REGISTRY` (key → {description, stability,
 *      defaultEnabled}). This is the single source of truth — the whole flag list is one object.
 *   2. `config.ts` calls `resolveFeatureFlags(FEATURE_REGISTRY, runtimeConfig.features)` once and
 *      exposes the typed result as `config.features`.
 *   3. Components gate on `config.features.<key>` (a compile error for unknown keys).
 *
 * Experimental features set `stability: "experimental"` + `defaultEnabled: false`, so they stay
 * OFF until an environment opts in via `runtime-config.json` `features: { <key>: true }`. When a
 * feature graduates, delete its registry entry — TypeScript then flags every now-dead usage.
 *
 * Pure (no React / no I/O), so it is unit-tested once here instead of per SPA.
 */

export type FeatureStability = "experimental" | "beta" | "stable";

export interface FeatureSpec {
  /** Human-facing one-liner — what the flag gates. */
  readonly description: string;
  /** Maturity. `experimental` features should default OFF. */
  readonly stability: FeatureStability;
  /** Value used when `runtime-config.json` does not override this flag. */
  readonly defaultEnabled: boolean;
}

export type FeatureRegistry = Readonly<Record<string, FeatureSpec>>;

/** The resolved, typed flag map: every registry key → effective boolean. */
export type ResolvedFeatures<R extends FeatureRegistry> = Readonly<Record<keyof R, boolean>>;

/**
 * Resolve effective flags = each registry default, overridden by a boolean in `overrides`.
 *
 * Robustness for a config authored by hand / drifted from the code:
 *   - a non-boolean override (string "true", number, null) is ignored → registry default wins;
 *   - an override key that is not in the registry is ignored (no crash, no silent new flag).
 * Only registry keys ever appear in the result, so consumers get exactly the typed surface.
 */
export function resolveFeatureFlags<R extends FeatureRegistry>(
  registry: R,
  overrides?: Readonly<Record<string, unknown>> | null,
): ResolvedFeatures<R> {
  const resolved = {} as Record<keyof R, boolean>;
  for (const key of Object.keys(registry) as (keyof R)[]) {
    const override = overrides ? overrides[key as string] : undefined;
    resolved[key] = typeof override === "boolean" ? override : registry[key].defaultEnabled;
  }
  return resolved;
}
