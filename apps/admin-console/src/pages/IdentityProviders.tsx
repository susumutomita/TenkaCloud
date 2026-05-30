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
import { useLang } from "../i18n";
import { formatRelativeTime } from "../lib/format";
import { CreateIdpModal } from "./CreateIdpModal";

/**
 * Issue #1293: System Admin → list / add / edit / delete SAML IdPs attached to
 * the Control Plane Cognito UserPool.
 *
 * Notes for the operator UI:
 *   - **Multi-IdP per UserPool**. The Hosted UI picker shows all IdPs at the
 *     same time. There is no domain-based auto-routing — Issue #1293 calls this
 *     out explicitly because the same email domain may be served by both an
 *     Entra ID and an Okta tenant in parallel.
 *   - **`Cognito sub` does not collide across IdPs**. We surface a help text
 *     under the table to keep admins from confusing same-email sign-ins as the
 *     same identity.
 *
 * The page is metadata-driven only — actual sign-in is exercised by following
 * the "Test sign-in" button which jumps to the Hosted UI authorize endpoint with
 * `identity_provider=<idpId>`.
 */
export function IdentityProvidersPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const lang = useLang();
  const client: IdpClient | null = useMemo(
    () => (auth.tokens ? createIdpClient(config, auth.tokens.idToken) : null),
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
      const url = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
      url.searchParams.set("client_id", config.cognitoClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scope);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("identity_provider", idpId);
      return url.toString();
    },
    [config],
  );

  if (!config.apiBaseUrl) {
    return (
      <Container
        header={
          <Header
            variant="h1"
            description="SAML identity providers attached to the System Admin Cognito UserPool."
          >
            Identity providers
          </Header>
        }
      >
        <Alert type="warning" header="IdP CRUD API not wired up in this environment">
          <SpaceBetween size="xs">
            <Box>
              Set <code>apiBaseUrl</code> in runtime-config.json or the dev <code>.env</code> and
              reload the page.
            </Box>
          </SpaceBetween>
        </Alert>
      </Container>
    );
  }

  return (
    <SpaceBetween size="m">
      <Header
        variant="h1"
        description="SAML identity providers attached to the System Admin Cognito UserPool. Same email may sign in via multiple IdPs — each is a separate identity."
        actions={
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            Add SAML IdP
          </Button>
        }
      >
        Identity providers
      </Header>
      {loadError ? <Alert type="error">{loadError}</Alert> : null}
      <Container>
        <Table
          columnDefinitions={[
            { id: "idpId", header: "ID", cell: (i: IdpSummary) => i.idpId },
            {
              id: "displayName",
              header: "Display name",
              cell: (i: IdpSummary) => i.displayName,
            },
            {
              id: "description",
              header: "Description",
              cell: (i: IdpSummary) => i.description ?? "—",
            },
            {
              id: "updatedAt",
              header: "Updated",
              // Issue #1362: ISO 生値ではなく 「N 日前」 表示 + hover で絶対時刻 tooltip。
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
                    Test sign-in
                  </Button>
                  <Button
                    variant="inline-link"
                    onClick={async () => {
                      if (!client) return;
                      if (!confirm(`Delete IdP "${i.idpId}"?`)) return;
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
                    Delete
                  </Button>
                </SpaceBetween>
              ),
            },
          ]}
          items={items ?? []}
          loading={items === null}
          loadingText="Loading…"
          empty={
            // Issue #1362: アイコン + 説明 + 行動誘導の 3 段で 「dev 感のある空表示」 を脱却。
            <Box textAlign="center" padding="l">
              <SpaceBetween size="xs">
                <Box variant="strong" color="text-status-inactive">
                  <Icon name="lock-private" size="big" variant="subtle" /> No SAML IdPs configured
                  yet
                </Box>
                <Box color="text-body-secondary">
                  Sign-in falls back to local Cognito email + password. Click{" "}
                  <strong>Add SAML IdP</strong> to wire Entra ID / Okta / etc.
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      </Container>
      <Alert type="info">
        Cognito treats <code>IdP A's user@example.com</code> and{" "}
        <code>IdP B's user@example.com</code> as separate identities. Same email across multiple
        IdPs ⇒ separate Users rows keyed by (idpId, subjectId).
      </Alert>
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
