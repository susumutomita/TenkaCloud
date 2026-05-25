import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
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
    return (
      <Alert type="warning" header="Per-tenant SAML SSO requires the silo isolation tier">
        This tenant runs on a pooled Cognito UserPool. Per-tenant IdP CRUD is only available on
        PLATINUM (silo) tier — please contact your account manager.
      </Alert>
    );
  }

  if (!config.apiBaseUrl) {
    return (
      <Alert type="warning">
        Tenant IdP CRUD API is not wired up in this environment. Set <code>apiBaseUrl</code> in
        runtime-config.json or the dev .env.
      </Alert>
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
              cell: (i: TenantIdpSummary) => i.updatedAt,
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
            <Box textAlign="center">
              No IdPs configured. Click <strong>Add SAML IdP</strong> to register one.
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
