import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Icon from "@cloudscape-design/components/icon";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import Textarea from "@cloudscape-design/components/textarea";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTenantIdpClient,
  describeTenantIdpError,
  type TenantIdpClient,
  type TenantIdpSummary,
} from "../api/idp-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useLang } from "../i18n";
import { formatRelativeTime } from "../lib/format";

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
  const lang = useLang();
  const client: TenantIdpClient | null = useMemo(
    () => (auth.tokens ? createTenantIdpClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );

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

  if (config.isolation !== "silo") {
    // Issue #1362: forbidden 時の placeholder を 「単発 Alert」 から friendly な
    // ヒーロー (= icon + 説明 + 次のアクション誘導) に格上げ。
    return (
      <Container
        header={
          <Header variant="h1" description="Per-tenant SAML SSO is a PLATINUM (silo) feature.">
            Identity providers
          </Header>
        }
      >
        <Box textAlign="center" padding="xxl">
          <SpaceBetween size="s">
            <Box variant="strong">
              <Icon name="lock-private" size="big" variant="subtle" /> Per-tenant SAML SSO requires
              the silo isolation tier
            </Box>
            <Box color="text-body-secondary">
              This tenant runs on a pooled Cognito UserPool. Per-tenant IdP CRUD is only available
              on PLATINUM (silo) tier — please contact your account manager.
            </Box>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  if (!config.apiBaseUrl) {
    return (
      <Container
        header={
          <Header variant="h1" description="SAML identity providers attached to this tenant.">
            Identity providers
          </Header>
        }
      >
        <Alert type="warning" header="Tenant IdP CRUD API not wired up">
          Set <code>apiBaseUrl</code> in runtime-config.json or the dev <code>.env</code> and reload
          the page.
        </Alert>
      </Container>
    );
  }

  return (
    <SpaceBetween size="m">
      <Header
        variant="h1"
        description={`SAML identity providers attached to ${config.tenantName}'s Cognito UserPool. The Hosted UI shows a picker for all configured IdPs.`}
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
            { id: "idpId", header: "ID", cell: (i: TenantIdpSummary) => i.idpId },
            {
              id: "displayName",
              header: "Display name",
              cell: (i: TenantIdpSummary) => i.displayName,
            },
            {
              id: "description",
              header: "Description",
              cell: (i: TenantIdpSummary) => i.description ?? "—",
            },
            {
              id: "updatedAt",
              header: "Updated",
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
                        setLoadError(describeTenantIdpError(err));
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
            // Issue #1362: アイコン + 説明 + 行動誘導の 3 段で UX を底上げ。
            <Box textAlign="center" padding="l">
              <SpaceBetween size="xs">
                <Box variant="strong" color="text-status-inactive">
                  <Icon name="lock-private" size="big" variant="subtle" /> No SAML IdPs configured
                  yet
                </Box>
                <Box color="text-body-secondary">
                  Tenant sign-in falls back to local Cognito email + password. Click{" "}
                  <strong>Add SAML IdP</strong> to wire Entra ID / Okta / etc.
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      </Container>
      <Alert type="info">
        Same email signed in via two different IdPs is treated as two separate identities (keyed by{" "}
        <code>(tenantId, idpId, subjectId)</code>). Plan your group → role mapping accordingly.
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

interface CreateIdpModalProps {
  readonly client: TenantIdpClient | null;
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
}

function CreateIdpModal({ client, onClose, onCreated, busy, setBusy }: CreateIdpModalProps) {
  const [idpId, setIdpId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [emailAttr, setEmailAttr] = useState(
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  );
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await client.create({
        idpId,
        displayName,
        ...(description ? { description } : {}),
        metadataXml,
        attributeMapping: { email: emailAttr },
        groupToRole: {},
      });
      await onCreated();
    } catch (err) {
      setError(describeTenantIdpError(err));
    } finally {
      setBusy(false);
    }
  }, [client, idpId, displayName, description, metadataXml, emailAttr, onCreated, setBusy]);

  return (
    <Modal
      visible
      onDismiss={onClose}
      header="Register SAML IdP"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={busy}>
              Register
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error ? <Alert type="error">{error}</Alert> : null}
        <FormField label="IdP ID" description="Cognito ProviderName. 3–32 chars, [A-Za-z0-9_-].">
          <Input value={idpId} onChange={(e) => setIdpId(e.detail.value)} />
        </FormField>
        <FormField label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.detail.value)} />
        </FormField>
        <FormField label="Description (optional)">
          <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
        </FormField>
        <FormField label="Email attribute (SAML)">
          <Input value={emailAttr} onChange={(e) => setEmailAttr(e.detail.value)} />
        </FormField>
        <FormField label="Metadata XML" description="Paste the full IdP metadata XML.">
          <Textarea
            value={metadataXml}
            onChange={(e) => setMetadataXml(e.detail.value)}
            rows={10}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
