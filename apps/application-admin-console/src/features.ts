import type { FeatureRegistry, ResolvedFeatures } from "@tenkacloud/web-kit";

/**
 * ADR-035: the single source of truth for this console's feature flags. Add one entry per
 * experimental feature (default OFF); gate UI on `config.features.<key>`; delete the entry when
 * the feature graduates. Enable per environment via `runtime-config.json` `features: { <key>: true }`.
 */
export const FEATURE_REGISTRY = {
  samlSso: {
    description: "Per-tenant SAML SSO — the Identity providers page + nav.",
    stability: "experimental",
    defaultEnabled: false,
  },
  nonAwsRuntime: {
    description: "Non-AWS (Sakura / Azure / GCP) team cloud-credentials panel.",
    stability: "experimental",
    defaultEnabled: false,
  },
  redTeam: {
    // The headline Battle feature: visible by default so operators can find + use it. The panel
    // carries an "experimental — not yet verified live on AWS" banner (the mechanism is unit-tested;
    // the cross-account live run is what's unproven), so it is honestly labeled rather than hidden.
    description: "Operator red-team console — fire disruptions at teams during a Battle.",
    stability: "experimental",
    defaultEnabled: true,
  },
  challengePrerequisiteGate: {
    // Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ)。 EventDetail の
    // "Progression / Gate (Advanced)" tab が編集 UI。 backend は per-tenant runtime flag
    // (GET /feature-flags の DDB row) だけを判定するため、 UI 側の有効判定もこの registry
    // default ではなく同 API を読む (= backend と判定源を一致させる)。
    description:
      "Progression Gate — the advanced event rule that locks unlock-target problems until a gate challenge is completed (with per-team overrides / completion bonuses).",
    stability: "experimental",
    defaultEnabled: false,
  },
} as const satisfies FeatureRegistry;

export type AppFeatures = ResolvedFeatures<typeof FEATURE_REGISTRY>;
