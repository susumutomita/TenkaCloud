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
import { useT } from "../i18n";
import { cognitoOrigin, spEntityId } from "../lib/cognito";

/** The translate function returned by `useT` (web-kit's `t(key, params?)`). */
type TFn = ReturnType<typeof useT>;

interface CreateIdpModalProps {
  readonly client: TenantIdpClient | null;
  readonly cognitoDomain: string;
  /** User Pool ID derived from the admin's ID token, used to render the real SP Entity ID. */
  readonly userPoolId?: string;
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
}

type SamlProvider = "entra" | "google" | "generic";

interface ProviderGuide {
  readonly label: string;
  readonly description: string;
  readonly steps: readonly string[];
}

const DEFAULT_EMAIL_ATTRIBUTE =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const METADATA_XML_ACCEPT = ".xml,text/xml,application/xml";

/** Provider setup guides, built from i18n so the steps localize (generic has 2 steps, others 3). */
function buildProviderGuides(t: TFn): Record<SamlProvider, ProviderGuide> {
  const guide = (key: SamlProvider, stepCount: number): ProviderGuide => ({
    label: t(`create_idp.guide_${key}_label`),
    description: t(`create_idp.guide_${key}_description`),
    steps: Array.from({ length: stepCount }, (_, i) => t(`create_idp.guide_${key}_step_${i + 1}`)),
  });
  return {
    entra: guide("entra", 3),
    google: guide("google", 3),
    generic: guide("generic", 2),
  };
}

function buildCognitoAcsUrl(cognitoDomain: string): string {
  return new URL("/saml2/idpresponse", cognitoOrigin(cognitoDomain)).toString();
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
  const t = useT();
  return (
    <SpaceBetween size="xxs">
      <Box variant="awsui-key-label">{label}</Box>
      <CopyToClipboard
        textToCopy={value}
        copyButtonText={t("create_idp.copy", { label })}
        copyButtonAriaLabel={t("create_idp.copy", { label })}
        copySuccessText={t("create_idp.copied")}
        copyErrorText={t("create_idp.copy_failed")}
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
  userPoolId,
  onClose,
  onCreated,
  busy,
  setBusy,
}: CreateIdpModalProps) {
  const t = useT();
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
  const guides = useMemo(() => buildProviderGuides(t), [t]);
  const tiles = useMemo(
    () =>
      (Object.entries(guides) as [SamlProvider, ProviderGuide][]).map(([value, g]) => ({
        value,
        label: g.label,
        description: g.description,
      })),
    [guides],
  );
  const providerGuide = guides[provider];
  const spEntity = spEntityId(userPoolId);

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

  const onMetadataFilesChange = useCallback(
    async (files: File[]) => {
      const requestId = ++metadataReadRequestId.current;
      setMetadataFiles(files);
      setMetadataFileError(null);
      const [file] = files;
      if (!file) return;
      const result = await file.text().then(
        (contents) => ({ contents }),
        () => ({ error: t("create_idp.read_metadata_error") }),
      );
      if (requestId !== metadataReadRequestId.current) return;
      if ("error" in result) {
        setMetadataFileError(result.error);
        return;
      }
      if (!result.contents.trim()) {
        setMetadataFileError(t("create_idp.empty_metadata_error"));
        return;
      }
      setMetadataXml(result.contents);
    },
    [t],
  );

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={t("create_idp.header")}
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onClose} disabled={busy}>
              {t("create_idp.cancel")}
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={busy}>
              {t("create_idp.register")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error ? <Alert type="error">{error}</Alert> : null}
        <FormField
          label={t("create_idp.idp_id_label")}
          description={t("create_idp.idp_id_description")}
        >
          <Input value={idpId} onChange={(e) => setIdpId(e.detail.value)} />
        </FormField>
        <FormField label={t("create_idp.display_name_label")}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.detail.value)} />
        </FormField>
        <FormField label={t("create_idp.description_label")}>
          <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
        </FormField>
        <FormField label={t("create_idp.email_attr_label")}>
          <Input value={emailAttr} onChange={(e) => setEmailAttr(e.detail.value)} />
        </FormField>
        <FormField
          label={t("create_idp.provider_label")}
          description={t("create_idp.provider_description")}
        >
          <Tiles
            value={provider}
            items={tiles}
            columns={2}
            onChange={(e) => setProvider(e.detail.value as SamlProvider)}
          />
        </FormField>
        <ExpandableSection
          defaultExpanded
          header={t("create_idp.setup_guide_header", { provider: providerGuide.label })}
        >
          <SpaceBetween size="s">
            {providerGuide.steps.map((step) => (
              <Box key={step}>{step}</Box>
            ))}
            <CopyableSetupValue
              label={t("create_idp.acs_url_label")}
              value={acsUrl}
              description={t("create_idp.acs_url_description")}
            />
            <CopyableSetupValue
              label={t("create_idp.sp_entity_label")}
              value={spEntity}
              description={
                userPoolId
                  ? t("create_idp.sp_entity_description")
                  : t("create_idp.sp_entity_description_placeholder")
              }
            />
            <CopyableSetupValue
              label={t("create_idp.email_attr_map_label")}
              value={emailAttr}
              description={t("create_idp.email_attr_map_description")}
            />
          </SpaceBetween>
        </ExpandableSection>
        <FormField
          label={t("create_idp.metadata_file_label")}
          description={t("create_idp.metadata_file_description")}
        >
          <FileUpload
            value={metadataFiles}
            accept={METADATA_XML_ACCEPT}
            errorText={metadataFileError ?? undefined}
            onChange={(e) => void onMetadataFilesChange(e.detail.value)}
          />
        </FormField>
        <FormField
          label={t("create_idp.metadata_xml_label")}
          description={t("create_idp.metadata_xml_description")}
        >
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
