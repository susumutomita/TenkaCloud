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
  createIdpClient,
  describeIdpError,
  type IdpClient,
  type IdpSummary,
} from "../api/idp-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useLang, useT } from "../i18n";
import { cognitoOrigin } from "../lib/cognito";
import { formatRelativeTime } from "../lib/format";
import { CreateIdpModal } from "./CreateIdpModal";

/**
 * Issue #1293: System Admin → list / add / edit / delete SAML IdPs attached to
 * the Control Plane Cognito UserPool.
 *
 * Hidden behind the default-off `samlSso` feature until the SAML sign-in path is
 * verified live, so it isn't mistaken for ready. The Hosted UI picker shows all IdPs at once
 * (no domain auto-routing); the "Test sign-in" button jumps to the authorize endpoint with
 * `identity_provider=<idpId>`.
 */
export function IdentityProvidersPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const lang = useLang();
  const client: IdpClient | null = useMemo(
    () =>
      auth.tokens && config.features?.samlSso ? createIdpClient(config, auth.tokens.idToken) : null,
    [auth.tokens, config],
  );

  const [items, setItems] = useState<readonly IdpSummary[] | null>(null);
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
      setLoadError(describeIdpError(err));
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
          <Button variant="primary" onClick={() => setShowCreate(true)}>
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
              cell: (i: IdpSummary) => i.idpId,
            },
            {
              id: "displayName",
              header: t("identity_providers.col_display_name"),
              cell: (i: IdpSummary) => i.displayName,
            },
            {
              id: "description",
              header: t("identity_providers.col_description"),
              cell: (i: IdpSummary) => i.description ?? t("identity_providers.value_dash"),
            },
            {
              id: "updatedAt",
              header: t("identity_providers.col_updated"),
              cell: (i: IdpSummary) => (
                <span title={i.updatedAt}>{formatRelativeTime(i.updatedAt, lang)}</span>
              ),
            },
            {
              id: "actions",
              header: "",
              cell: (i: IdpSummary) => (
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
                    onClick={async () => {
                      // defensive: rows only exist on client.list success, so client is non-null here.
                      /* v8 ignore next */
                      if (!client) return;
                      if (!confirm(t("identity_providers.delete_confirm", { idpId: i.idpId })))
                        return;
                      setBusy(true);
                      try {
                        await client.remove(i.idpId);
                        await refresh();
                      } catch (err) {
                        setLoadError(describeIdpError(err));
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
          client={client}
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
