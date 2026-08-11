import { useEffect, useState } from "react";
import { useApiClient } from "../api/client";
import type { AppConfig } from "../config";
import type { AppFeatures } from "../features";
import { FEATURE_REGISTRY } from "../features";

/**
 * Issue #2231: merges the tenant's runtime feature-flag overrides
 * (`GET /feature-flags`, #2265/#2267 — readable by any tenant role) on top of the
 * deploy-time baseline (`config.features` = registry default + `runtime-config.json`
 * override, resolved once in `loadConfig()`).
 *
 * `loadConfig()` runs at app bootstrap, before Cognito auth completes (`main.tsx`
 * calls it to seed OAuth redirect params), so it cannot itself call an
 * authenticated endpoint. Instead this hook lives inside `<AuthProvider>` and
 * fetches once `useApiClient` returns a token-bearing client, then layers the API
 * response over `config.features` — a key the API does not mention keeps the
 * baseline's value (deploy-time default already applied), matching the intended
 * precedence: API override > runtime-config.json override > registry default.
 *
 * Fails OPEN, not closed: flags gate optional UI (a tab, a panel), not a security
 * boundary — the backend independently re-checks anything security-relevant on
 * every mutating call. A network error or a demo-mode 501 (`createDemoApiClient`
 * does not simulate this route) simply leaves `config.features` at its baseline,
 * exactly as it behaved before this hook existed.
 */
export function useEffectiveFeatures(config: AppConfig): AppFeatures | undefined {
  const apiClient = useApiClient(config);
  const [features, setFeatures] = useState(config.features);

  useEffect(() => {
    // Demo mode has no real per-tenant flag store; keep the static baseline.
    if (!apiClient || config.mode === "demo") return;
    let cancelled = false;
    apiClient
      .get<{ flags: Readonly<Record<string, unknown>> }>("/feature-flags")
      .then((res) => {
        if (cancelled) return;
        // `prev` is the current effective features (seeded from config.features at mount,
        // then layered on each successful fetch) — folding on it rather than re-reading
        // config.features keeps that value out of the dependency list without ever losing
        // the deploy-time baseline for keys the API response doesn't mention.
        setFeatures((prev) => mergeApiFlags(prev, res.flags));
      })
      .catch(() => {
        // Fail-open: keep the deploy-time baseline (see docblock above).
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, config.mode]);

  return features;
}

/**
 * Layer API-sourced boolean overrides onto an already-resolved `AppFeatures` map.
 * Only registry keys with a boolean API value are overridden (unknown keys / non-boolean
 * values are ignored, same robustness contract as `resolveFeatureFlags` in web-kit); a
 * key absent from `apiFlags` keeps `base`'s value untouched.
 */
function mergeApiFlags(
  base: AppFeatures | undefined,
  apiFlags: Readonly<Record<string, unknown>>,
): AppFeatures | undefined {
  if (!base) return base;
  const merged = { ...base };
  for (const key of Object.keys(FEATURE_REGISTRY) as (keyof AppFeatures)[]) {
    const override = apiFlags[key as string];
    if (typeof override === "boolean") merged[key] = override;
  }
  return merged;
}
