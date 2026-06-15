import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Icon from "@cloudscape-design/components/icon";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTenantIdpClient,
  describeTenantIdpError,
  type TenantIdpClient,
  type TenantIdpSummary,
} from "../api/idp-client";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken, resolveTenantConsoleAccess } from "../auth/claims";
import type { AppConfig } from "../config";
import { useLang, useT } from "../i18n";
import { cognitoOrigin, userPoolIdFromIssuer } from "../lib/cognito";
import { formatRelativeTime } from "../lib/format";
import { CreateIdpModal } from "./CreateIdpModal";

/**
 * Issue #1294: Tenant Admin → list / add / edit / delete SAML IdPs attached
 * to this tenant's Cognito UserPool.
 *
 * Notes:
 *   - Visible only when `config.isolation === "silo"` (= PLATINUM tier with a
 *     dedicated UserPool). Pooled tiers share a UserPool so per-tenant IdP
 *     mutations would leak across tenants. The pooled-tier story is tracked
 *     separately (PR body, "pooled vs silo").
 *   - Tenant isolation is enforced server-side from `custom:tenantId` claim —
 *     the client never sends a tenantId.
 */
export function IdentityProvidersPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const lang = useLang();
  const claims = useMemo(
    () => (auth.tokens ? decodeIdToken(auth.tokens.idToken) : null),
    [auth.tokens],
  );
  const canMutateTenant = resolveTenantConsoleAccess(claims).canMutateTenant;
  const client: TenantIdpClient | null = useMemo(
    () =>
      auth.tokens && config.features?.samlSso
        ? createTenantIdpClient(config, auth.tokens.idToken)
        : null,
    [auth.tokens, config],
  );

  // The SP Entity ID is `urn:amazon:cognito:sp:<userPoolId>`; the pool id lives in the signed-in
  // admin's own ID token (`iss`), so we can show the real value instead of a placeholder to paste.
  const userPoolId = useMemo(() => userPoolIdFromIssuer(claims?.iss), [claims]);

  const [items, setItems] = useState<readonly TenantIdpSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setLoadError(null);
      const list = await client.list();
      setItems(list);
    } catch (err) {
      setLoadError(describeTenantIdpError(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hostedUiTestSignInUrl = useCallback(
    (idpId: string) => {
      const url = new URL("/oauth2/authorize", cognitoOrigin(config.cognitoDomain));
      url.searchParams.set("client_id", config.cognitoClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scope);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("identity_provider", idpId);
      return url.toString();
    },
    [config],
  );

  if (!config.features?.samlSso) {
    // Feature-flagged off until verified end-to-end. Gate the page itself (not just the nav) so a
    // direct URL does not expose an unproven feature.
    return (
      <Container
        header={
          <Header variant="h1" description={t("identity_providers.feature_disabled_body")}>
            {t("identity_providers.title")}
          </Header>
        }
      >
        <Box textAlign="center" padding="xxl">
          <Box variant="strong">
            <Icon name="lock-private" size="big" variant="subtle" />{" "}
            {t("identity_providers.feature_disabled_header")}
          </Box>
        </Box>
      </Container>
    );
  }

  if (config.isolation !== "silo") {
    // Issue #1362: forbidden 時の placeholder を 「単発 Alert」 から friendly な
    // ヒーロー (= icon + 説明 + 次のアクション誘導) に格上げ。
    return (
      <Container
        header={
          <Header variant="h1" description={t("identity_providers.silo_only_description")}>
            {t("identity_providers.title")}
          </Header>
        }
      >
        <Box textAlign="center" padding="xxl">
          <SpaceBetween size="s">
            <Box variant="strong">
              <Icon name="lock-private" size="big" variant="subtle" />{" "}
              {t("identity_providers.silo_only_header")}
            </Box>
            <Box color="text-body-secondary">{t("identity_providers.silo_only_body")}</Box>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  if (!config.apiBaseUrl) {
    return (
      <Container
        header={
          <Header variant="h1" description={t("identity_providers.description")}>
            {t("identity_providers.title")}
          </Header>
        }
      >
        <Alert type="warning" header={t("identity_providers.not_wired_header")}>
          {t("identity_providers.not_wired_body")}
        </Alert>
      </Container>
    );
  }

  return (
    <SpaceBetween size="m">
      <Header
        variant="h1"
        description={t("identity_providers.description")}
        actions={
          <Button variant="primary" disabled={!canMutateTenant} onClick={() => setShowCreate(true)}>
            {t("identity_providers.add_button")}
          </Button>
        }
      >
        {t("identity_providers.title")}
      </Header>
      {loadError ? <Alert type="error">{loadError}</Alert> : null}
      <Container>
        <Table
          columnDefinitions={[
            {
              id: "idpId",
              header: t("identity_providers.col_id"),
              cell: (i: TenantIdpSummary) => i.idpId,
            },
            {
              id: "displayName",
              header: t("identity_providers.col_display_name"),
              cell: (i: TenantIdpSummary) => i.displayName,
            },
            {
              id: "description",
              header: t("identity_providers.col_description"),
              cell: (i: TenantIdpSummary) => i.description ?? t("identity_providers.value_dash"),
            },
            {
              id: "updatedAt",
              header: t("identity_providers.col_updated"),
              // Issue #1362: ISO 生値ではなく 「N 日前」 表示 + hover で絶対時刻 tooltip。
              cell: (i: TenantIdpSummary) => (
                <span title={i.updatedAt}>{formatRelativeTime(i.updatedAt, lang)}</span>
              ),
            },
            {
              id: "actions",
              header: "",
              cell: (i: TenantIdpSummary) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="external"
                    variant="inline-link"
                    href={hostedUiTestSignInUrl(i.idpId)}
                    target="_blank"
                  >
                    {t("identity_providers.test_sign_in")}
                  </Button>
                  <Button
                    variant="inline-link"
                    disabled={!canMutateTenant}
                    onClick={async () => {
                      /* v8 ignore next -- defensive: the Delete button is disabled={!canMutateTenant}, and a null client implies !canMutateTenant (null claims → viewer), so the !client side is unreachable here */
                      if (!client || !canMutateTenant) return;
                      if (!confirm(t("identity_providers.delete_confirm", { idpId: i.idpId })))
                        return;
                      setBusy(true);
                      try {
                        await client.remove(i.idpId);
                        await refresh();
                      } catch (err) {
                        setLoadError(describeTenantIdpError(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("identity_providers.delete")}
                  </Button>
                </SpaceBetween>
              ),
            },
          ]}
          items={items ?? []}
          loading={items === null}
          loadingText={t("identity_providers.loading")}
          empty={
            // Issue #1362: アイコン + 説明 + 行動誘導の 3 段で UX を底上げ。
            <Box textAlign="center" padding="l">
              <SpaceBetween size="xs">
                <Box variant="strong" color="text-status-inactive">
                  <Icon name="lock-private" size="big" variant="subtle" />{" "}
                  {t("identity_providers.empty_header")}
                </Box>
                <Box color="text-body-secondary">{t("identity_providers.empty_body")}</Box>
              </SpaceBetween>
            </Box>
          }
        />
      </Container>
      <Alert type="info">{t("identity_providers.info_alert")}</Alert>
      {showCreate ? (
        <CreateIdpModal
          /* v8 ignore next -- defensive: the Add button is disabled={!canMutateTenant}, so a viewer can never open this modal; the `: null` (viewer) branch is unreachable */
          client={canMutateTenant ? client : null}
          cognitoDomain={config.cognitoDomain}
          userPoolId={userPoolId}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refresh();
          }}
          busy={busy}
          setBusy={setBusy}
        />
      ) : null}
    </SpaceBetween>
  );
}
