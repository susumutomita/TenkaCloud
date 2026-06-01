import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FileUpload from "@cloudscape-design/components/file-upload";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import Tiles from "@cloudscape-design/components/tiles";
import { useCallback, useMemo, useRef, useState } from "react";
import { describeTenantIdpError, type TenantIdpClient } from "../api/idp-client";

interface CreateIdpModalProps {
  readonly client: TenantIdpClient | null;
  readonly cognitoDomain: string;
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
}

type SamlProvider = "entra" | "google" | "okta" | "generic";

interface ProviderGuide {
  readonly label: string;
  readonly description: string;
  readonly steps: readonly string[];
}

const DEFAULT_EMAIL_ATTRIBUTE =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const SP_ENTITY_ID_PATTERN = "urn:amazon:cognito:sp:<userPoolId>";
const METADATA_XML_ACCEPT = ".xml,text/xml,application/xml";
const EMPTY_METADATA_FILE_ERROR = "The selected metadata XML file is empty.";
const READ_METADATA_FILE_ERROR =
  "Could not read the selected metadata XML file. Try another file or paste the XML below.";

const PROVIDER_GUIDES: Record<SamlProvider, ProviderGuide> = {
  entra: {
    label: "Microsoft Entra ID",
    description: "Microsoft Entra enterprise application",
    steps: [
      "In Microsoft Entra ID, open Enterprise applications -> New application -> Single sign-on -> SAML.",
      "Set Reply URL to the ACS URL and Identifier to the SP Entity ID below.",
      "Download Federation Metadata XML, then upload it below.",
    ],
  },
  google: {
    label: "Google Workspace",
    description: "Google Admin custom SAML app",
    steps: [
      "In Google Workspace, open Admin console -> Apps -> Web and mobile apps -> Add custom SAML app.",
      "Enter the ACS URL and Entity ID below.",
      "Download the IdP metadata, then upload it below.",
    ],
  },
  okta: {
    label: "Okta",
    description: "Okta SAML 2.0 app integration",
    steps: [
      "In Okta, open Applications -> Create App Integration -> SAML 2.0.",
      "Set Single sign-on URL to the ACS URL and Audience URI to the SP Entity ID below.",
      "Get the Identity Provider metadata URL or XML, then upload the XML below.",
    ],
  },
  generic: {
    label: "Generic SAML",
    description: "Any SAML 2.0 identity provider",
    steps: [
      "Give the IdP administrator the ACS URL, SP Entity ID, and email attribute below.",
      "Configure the IdP metadata XML, then upload it below.",
    ],
  },
};

const PROVIDER_TILES = (Object.entries(PROVIDER_GUIDES) as [SamlProvider, ProviderGuide][]).map(
  ([value, guide]) => ({
    value,
    label: guide.label,
    description: guide.description,
  }),
);

function buildCognitoAcsUrl(cognitoDomain: string): string {
  const origin = cognitoDomain.startsWith("https://") ? cognitoDomain : `https://${cognitoDomain}`;
  return new URL("/saml2/idpresponse", origin).toString();
}

function CopyableSetupValue({
  label,
  value,
  description,
}: {
  readonly label: string;
  readonly value: string;
  readonly description: string;
}) {
  return (
    <SpaceBetween size="xxs">
      <Box variant="awsui-key-label">{label}</Box>
      <CopyToClipboard
        textToCopy={value}
        copyButtonText={`Copy ${label}`}
        copyButtonAriaLabel={`Copy ${label}`}
        copySuccessText="Copied"
        copyErrorText="Copy failed"
        variant="inline"
      />
      <Box color="text-body-secondary">{description}</Box>
    </SpaceBetween>
  );
}

/**
 * Tenant SAML IdP 登録モーダル。 `IdentityProvidersPage` から切り出し、 Modal / FormField /
 * Input / Textarea 依存をこの module に閉じ込めた (= ページの高結合を解消)。
 */
export function CreateIdpModal({
  client,
  cognitoDomain,
  onClose,
  onCreated,
  busy,
  setBusy,
}: CreateIdpModalProps) {
  const [idpId, setIdpId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [metadataFiles, setMetadataFiles] = useState<readonly File[]>([]);
  const [metadataFileError, setMetadataFileError] = useState<string | null>(null);
  const [emailAttr, setEmailAttr] = useState(DEFAULT_EMAIL_ATTRIBUTE);
  const [provider, setProvider] = useState<SamlProvider>("generic");
  const [error, setError] = useState<string | null>(null);
  const metadataReadRequestId = useRef(0);
  const acsUrl = useMemo(() => buildCognitoAcsUrl(cognitoDomain), [cognitoDomain]);
  const providerGuide = PROVIDER_GUIDES[provider];

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

  const onMetadataFilesChange = useCallback(async (files: File[]) => {
    const requestId = ++metadataReadRequestId.current;
    setMetadataFiles(files);
    setMetadataFileError(null);
    const [file] = files;
    if (!file) return;
    const result = await file.text().then(
      (contents) => ({ contents }),
      () => ({ error: READ_METADATA_FILE_ERROR }),
    );
    if (requestId !== metadataReadRequestId.current) return;
    if ("error" in result) {
      setMetadataFileError(result.error);
      return;
    }
    if (!result.contents.trim()) {
      setMetadataFileError(EMPTY_METADATA_FILE_ERROR);
      return;
    }
    setMetadataXml(result.contents);
  }, []);

  return (
    <Modal
      visible
      onDismiss={onClose}
      header="Register SAML IdP"
      size="large"
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
        <FormField
          label="Identity provider"
          description="Choose a provider to show concise SAML application setup steps."
        >
          <Tiles
            value={provider}
            items={PROVIDER_TILES}
            columns={2}
            onChange={(e) => setProvider(e.detail.value as SamlProvider)}
          />
        </FormField>
        <ExpandableSection defaultExpanded header={`${providerGuide.label} setup guide`}>
          <SpaceBetween size="s">
            {providerGuide.steps.map((step) => (
              <Box key={step}>{step}</Box>
            ))}
            <CopyableSetupValue
              label="ACS URL (Reply / SSO URL)"
              value={acsUrl}
              description="Enter this as the assertion consumer service, reply, or single sign-on URL."
            />
            <CopyableSetupValue
              label="SP Entity ID / Identifier (Audience)"
              value={SP_ENTITY_ID_PATTERN}
              description="Replace <userPoolId> with the relevant User Pool ID from the AWS Cognito console."
            />
            <CopyableSetupValue
              label="Email attribute mapping"
              value={emailAttr}
              description="Map the IdP email claim to this SAML attribute. It follows the Email attribute (SAML) field above."
            />
          </SpaceBetween>
        </ExpandableSection>
        <FormField label="Metadata XML file" description="Upload the IdP metadata as an .xml file.">
          <FileUpload
            value={metadataFiles}
            accept={METADATA_XML_ACCEPT}
            errorText={metadataFileError ?? undefined}
            onChange={(e) => void onMetadataFilesChange(e.detail.value)}
          />
        </FormField>
        <FormField label="Metadata XML" description="Paste the full IdP metadata XML.">
          <Textarea
            value={metadataXml}
            onChange={(e) => {
              setMetadataXml(e.detail.value);
              setMetadataFileError(null);
            }}
            rows={10}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
