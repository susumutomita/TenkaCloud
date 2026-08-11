import type { FeatureRegistry, ResolvedFeatures } from "@tenkacloud/web-kit";

/**
 * The single source of truth for this console's feature flags. Add one entry per
 * experimental feature (default OFF); gate UI on `config.features?.<key>`; delete the entry when
 * the feature graduates. Enable per environment via `runtime-config.json` `features: { <key>: true }`.
 */
export const FEATURE_REGISTRY = {
  samlSso: {
    description: "System Admin SAML SSO — the Identity providers page + nav.",
    stability: "experimental",
    defaultEnabled: false,
  },
} as const satisfies FeatureRegistry;

export type AppFeatures = ResolvedFeatures<typeof FEATURE_REGISTRY>;
