import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useCallback, useState } from "react";
import { describeIdpError, type IdpClient } from "../api/idp-client";
import { useT } from "../i18n";

interface CreateIdpModalProps {
  readonly client: IdpClient | null;
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
  readonly busy: boolean;
  readonly setBusy: (b: boolean) => void;
}

/**
 * SAML IdP 登録モーダル。 `IdentityProvidersPage` から切り出し、 Modal / FormField / Input /
 * Textarea 依存をこの module に閉じ込めた (= ページの高結合を解消)。
 */
export function CreateIdpModal({ client, onClose, onCreated, busy, setBusy }: CreateIdpModalProps) {
  const t = useT();
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
      setError(describeIdpError(err));
    } finally {
      setBusy(false);
    }
  }, [client, idpId, displayName, description, metadataXml, emailAttr, onCreated, setBusy]);

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={t("create_idp.header")}
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
          label={t("create_idp.metadata_xml_label")}
          description={t("create_idp.metadata_xml_description")}
        >
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
