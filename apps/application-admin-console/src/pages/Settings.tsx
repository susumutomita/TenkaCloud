import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Toggle from "@cloudscape-design/components/toggle";
import { useCallback, useEffect, useState } from "react";
import { canMutateTenant, useApiClient } from "../api/client";
import type { AppConfig } from "../config";
import { FEATURE_REGISTRY } from "../features";
import { useT } from "../i18n";

type FlagKey = keyof typeof FEATURE_REGISTRY;
const FLAG_KEYS = Object.keys(FEATURE_REGISTRY) as readonly FlagKey[];

/**
 * Issue #2231 (ADR-035, 3/3 — backend API #2265/#2267, config merge #2269, this page):
 * per-tenant runtime feature-flag toggle UI.
 *
 * Read (`GET /feature-flags`) is available to any tenant role — this page still renders
 * for everyone so a TenantOperator / TenantViewer can see what's enabled, but every Toggle
 * is `disabled` unless `canMutateTenant` (mirrors the `/admin/feature-flags` write scope
 * enforced server-side; the disabled UI is a UX signal, not the authorization boundary).
 * A stored override is authoritative; a key with no stored override falls back to the
 * registry default (`FEATURE_REGISTRY[key].defaultEnabled`), matching `resolveFeatureFlags`.
 */
export function SettingsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);

  const [flags, setFlags] = useState<Readonly<Record<string, boolean>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<FlagKey | null>(null);

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;
    apiClient
      .get<{ flags: Readonly<Record<string, boolean>> }>("/feature-flags")
      .then((res) => {
        if (!cancelled) setFlags(res.flags);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t("settings.load_error"));
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, t]);

  // Fallback order matters, and it has to match what actually gates the feature.
  //
  // A per-tenant override wins when one is stored. When none is, the effective value is
  // the deploy-time override from `runtime-config.json` (`config.features`) — that is what
  // `AppLayout` uses to decide whether the nav shows "ID プロバイダ", and what
  // `IdentityProviders` uses to gate the page. Only when neither exists does the
  // hardcoded registry default apply.
  //
  // Reading `config.features` here was missing, so a tenant that had `samlSso` enabled at
  // deploy time (the Lite setup path) saw this toggle rendered OFF while the feature was
  // live and reachable — the screen contradicted the thing it is supposed to describe.
  const resolveEnabled = useCallback(
    (key: FlagKey): boolean =>
      flags?.[key] ?? config.features?.[key] ?? FEATURE_REGISTRY[key].defaultEnabled,
    [flags, config.features],
  );

  const handleToggle = useCallback(
    async (key: FlagKey, next: boolean) => {
      /* v8 ignore next -- defensive: without an apiClient the flags never load, the spinner renders, and no Toggle exists to click, so this guard's true branch is unreachable from the UI */
      if (!apiClient) return;
      // A save is in flight for another key (the in-flight key's own Toggle is disabled);
      // ignore the click so concurrent full-replace PUTs can't race each other.
      if (savingKey) return;
      const previous = flags ?? {};
      // PUT /admin/feature-flags is full-replace (see feature-flags.ts's putFeatureFlags
      // docblock) — send every known key's current resolved value, not just the one that
      // changed, or an un-toggled flag with no prior stored override would silently reset
      // to its registry default.
      const nextFlags: Record<string, boolean> = {};
      for (const k of FLAG_KEYS) nextFlags[k] = k === key ? next : resolveEnabled(k);
      setSaveError(null);
      setSavingKey(key);
      // Optimistic update — rolled back on failure below.
      setFlags(nextFlags);
      try {
        const res = await apiClient.put<{ flags: Readonly<Record<string, boolean>> }>(
          "/admin/feature-flags",
          nextFlags,
        );
        setFlags(res.flags);
      } catch {
        setFlags(previous);
        setSaveError(t("settings.save_error"));
      } finally {
        setSavingKey(null);
      }
    },
    [apiClient, flags, savingKey, resolveEnabled, t],
  );

  return (
    <Container header={<Header variant="h1">{t("settings.header")}</Header>}>
      <SpaceBetween size="m">
        <Box color="text-body-secondary">{t("settings.description")}</Box>
        {!canMutate && <Alert type="info">{t("settings.readonly_notice")}</Alert>}
        {loadError && <Alert type="error">{loadError}</Alert>}
        {saveError && <Alert type="error">{saveError}</Alert>}
        {!flags && !loadError ? (
          <Spinner />
        ) : (
          <SpaceBetween size="s">
            {FLAG_KEYS.map((key) => (
              <Container key={key}>
                <SpaceBetween size="xs">
                  <Toggle
                    checked={resolveEnabled(key)}
                    disabled={!canMutate || !apiClient || savingKey === key}
                    onChange={({ detail }) => void handleToggle(key, detail.checked)}
                  >
                    {key}
                  </Toggle>
                  <Box color="text-body-secondary" fontSize="body-s">
                    {FEATURE_REGISTRY[key].description}
                    {FEATURE_REGISTRY[key].stability === "experimental" &&
                      ` (${t("settings.stability_experimental")})`}
                  </Box>
                </SpaceBetween>
              </Container>
            ))}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}
