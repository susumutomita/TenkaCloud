import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Toggle from "@cloudscape-design/components/toggle";
import { useCallback, useEffect, useState } from "react";
import { type ApiClient, useApiClient } from "../api/client";
import {
  deleteTenantSamlConfig,
  getTenantSamlConfig,
  putTenantSamlConfig,
  type TenantSamlConfigView,
} from "../api/tenant-saml-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

/**
 * Issue #839 follow-up Phase B: Tenant 管理者が自社の SAML IdP (= Entra ID / Okta /
 * Google Workspace 等) を画面から設定する page。
 *
 * UI flow:
 *  1. 初回 GET → enabled:false なら 「未設定」 表示 + 「設定する」 button
 *  2. PUT → backend が Cognito UserPool に IdP 登録 + UserPoolClient mutate + DDB persist
 *  3. enforceSamlOnly toggle ON → 2-step 確認 modal で 「password 経路を閉じる」 と明示
 *  4. DELETE → 確認 modal 後に IdP 削除 + COGNITO 経路復元
 *
 * 設計上の重要事項:
 *  - **lock-out 防止**: enforceSamlOnly を ON にする前に確認 modal を出す (= ON のまま
 *    SAML 設定が壊れていると全 user がログインできなくなる)
 *  - **pooled tenant warning**: pooled mode では UserPool を全 tenant が共有するため、
 *    1 tenant の設定が他 tenant の sign-in に影響する。 警告 Alert を表示
 *  - **更新成功後の hint**: 「次のサインインから新しい設定が反映されます。 既にサインイン中の
 *    user は影響を受けません」 を表示し UX 不安を緩和する
 */
export function SamlSsoPage({ config }: { config: AppConfig }) {
  const t = useT();
  const apiClient = useApiClient(config);
  const [view, setView] = useState<TenantSamlConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // form state
  const [metadataUrl, setMetadataUrl] = useState("");
  const [providerName, setProviderName] = useState("CompanySAML");
  const [enforceSamlOnly, setEnforceSamlOnly] = useState(false);
  const [pendingEnforceModal, setPendingEnforceModal] = useState(false);
  const [pendingDeleteModal, setPendingDeleteModal] = useState(false);

  const loadCurrent = useCallback(async () => {
    if (!apiClient) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getTenantSamlConfig(apiClient as ApiClient);
      setView(res);
      if (res.enabled) {
        setMetadataUrl(res.metadataUrl ?? "");
        setProviderName(res.providerName ?? "CompanySAML");
        setEnforceSamlOnly(res.enforceSamlOnly ?? false);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  const submit = useCallback(
    async (confirmedEnforce: boolean) => {
      if (!apiClient) return;
      setSubmitting(true);
      setSubmitError(null);
      setSuccessMessage(null);
      try {
        const next = await putTenantSamlConfig(apiClient as ApiClient, {
          metadataUrl,
          providerName,
          enforceSamlOnly: confirmedEnforce,
        });
        setView(next);
        setSuccessMessage(t("saml_sso.save_success"));
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [apiClient, metadataUrl, providerName, t],
  );

  const handleSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (enforceSamlOnly && !view?.enforceSamlOnly) {
      // enforceSamlOnly を OFF → ON に flip するときだけ確認 modal
      setPendingEnforceModal(true);
      return;
    }
    void submit(enforceSamlOnly);
  };

  const confirmEnforce = () => {
    setPendingEnforceModal(false);
    void submit(true);
  };

  const handleDelete = async () => {
    if (!apiClient) return;
    setPendingDeleteModal(false);
    setSubmitting(true);
    setSubmitError(null);
    setSuccessMessage(null);
    try {
      await deleteTenantSamlConfig(apiClient as ApiClient);
      setView({ enabled: false });
      setMetadataUrl("");
      setProviderName("CompanySAML");
      setEnforceSamlOnly(false);
      setSuccessMessage(t("saml_sso.delete_success"));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Issue #897: pooled tenant の Application Admin に SAML SSO 設定 page を出すのは責務違反
  // (= 自 tenant の設定が同 UserPool 上の他 tenant に副作用)。 pooled では完全に hide し、
  // PLATINUM (silo) tier への upgrade を促す。 UI 上で警告を出して \"気をつけて\" と punt
  // する従来の挙動は廃止。 未注入 (undefined) は安全側 = pooled 扱い。
  if (config.isolation !== "silo") {
    return (
      <SpaceBetween size="l">
        <Header variant="h1" description={t("saml_sso.platinum_only_description")}>
          {t("saml_sso.header")}
        </Header>
        <Alert type="info" header={t("saml_sso.platinum_only_header")}>
          {t("saml_sso.platinum_only_body")}
        </Alert>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("saml_sso.description")}>
        {t("saml_sso.header")}
      </Header>

      {loadError && (
        <Alert
          type="error"
          header={t("saml_sso.load_error_header")}
          dismissible
          onDismiss={() => setLoadError(null)}
        >
          {loadError}
        </Alert>
      )}

      {view?.enabled && (
        <Container header={<Header variant="h2">{t("saml_sso.current_header")}</Header>}>
          <KeyValuePairs
            columns={2}
            items={[
              { label: t("saml_sso.field_provider_name"), value: view.providerName ?? "—" },
              {
                label: t("saml_sso.field_metadata_url"),
                value: <code>{view.metadataUrl ?? "—"}</code>,
              },
              {
                label: t("saml_sso.field_enforce"),
                value: view.enforceSamlOnly ? t("saml_sso.enforce_on") : t("saml_sso.enforce_off"),
              },
              { label: t("saml_sso.field_updated_at"), value: view.updatedAt ?? "—" },
            ]}
          />
        </Container>
      )}

      <Container
        header={
          <Header variant="h2">
            {view?.enabled ? t("saml_sso.update_header") : t("saml_sso.setup_header")}
          </Header>
        }
      >
        <form onSubmit={handleSubmit}>
          <Form
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {view?.enabled && (
                  <Button onClick={() => setPendingDeleteModal(true)} disabled={submitting}>
                    {t("saml_sso.disable_button")}
                  </Button>
                )}
                <Button
                  variant="primary"
                  formAction="submit"
                  loading={submitting}
                  disabled={loading || !apiClient}
                >
                  {view?.enabled ? t("saml_sso.update_button") : t("saml_sso.save_button")}
                </Button>
              </SpaceBetween>
            }
          >
            <SpaceBetween size="m">
              <FormField
                label={t("saml_sso.field_metadata_url")}
                description={t("saml_sso.field_metadata_url_desc")}
              >
                <Input
                  value={metadataUrl}
                  placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml"
                  onChange={({ detail }) => setMetadataUrl(detail.value)}
                  disabled={submitting}
                  invalid={metadataUrl.length > 0 && !metadataUrl.startsWith("https://")}
                />
              </FormField>
              <FormField
                label={t("saml_sso.field_provider_name")}
                description={t("saml_sso.field_provider_name_desc")}
              >
                <Input
                  value={providerName}
                  onChange={({ detail }) => setProviderName(detail.value)}
                  disabled={submitting}
                  invalid={providerName.length > 0 && !/^[A-Za-z0-9_-]{3,32}$/.test(providerName)}
                />
              </FormField>
              <FormField
                label={t("saml_sso.field_enforce")}
                description={t("saml_sso.field_enforce_desc")}
              >
                <Toggle
                  checked={enforceSamlOnly}
                  onChange={({ detail }) => setEnforceSamlOnly(detail.checked)}
                  disabled={submitting}
                >
                  {enforceSamlOnly ? t("saml_sso.enforce_on") : t("saml_sso.enforce_off")}
                </Toggle>
              </FormField>
            </SpaceBetween>
          </Form>
        </form>
      </Container>

      {successMessage && (
        <Alert
          type="success"
          header={t("saml_sso.save_success_header")}
          dismissible
          onDismiss={() => setSuccessMessage(null)}
        >
          {successMessage}
        </Alert>
      )}
      {submitError && (
        <Alert
          type="error"
          header={t("saml_sso.save_error_header")}
          dismissible
          onDismiss={() => setSubmitError(null)}
        >
          {submitError}
        </Alert>
      )}

      <Modal
        visible={pendingEnforceModal}
        header={t("saml_sso.enforce_modal_header")}
        onDismiss={() => setPendingEnforceModal(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setPendingEnforceModal(false)}>
                {t("saml_sso.modal_cancel")}
              </Button>
              <Button variant="primary" onClick={confirmEnforce}>
                {t("saml_sso.enforce_modal_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box variant="p">{t("saml_sso.enforce_modal_body")}</Box>
          <Alert type="warning">{t("saml_sso.enforce_modal_warning")}</Alert>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={pendingDeleteModal}
        header={t("saml_sso.delete_modal_header")}
        onDismiss={() => setPendingDeleteModal(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setPendingDeleteModal(false)}>
                {t("saml_sso.modal_cancel")}
              </Button>
              <Button variant="primary" onClick={() => void handleDelete()}>
                {t("saml_sso.delete_modal_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Box variant="p">{t("saml_sso.delete_modal_body")}</Box>
      </Modal>
    </SpaceBetween>
  );
}
