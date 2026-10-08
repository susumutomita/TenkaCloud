import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Tiles from "@cloudscape-design/components/tiles";
import { useState } from "react";
import type { CreateCompetitorAccountResponse } from "../../api/competitor-accounts-client";
import type { TeamCredentialProvider } from "../../api/team-credentials-client";
import { type AppConfig, isLocalHost } from "../../config";
import { useT } from "../../i18n";
import { AddAccountModal } from "./AddAccountModal";
import { TeamCloudCredentialsPanel } from "./TeamCloudCredentialsPanel";

type CloudProvider = "aws" | TeamCredentialProvider;
const PROVIDERS: readonly CloudProvider[] = ["aws", "gcp", "azure", "sakura"];

export function CloudConnectionModal({
  config,
  onDismiss,
  onSuccess,
}: {
  config: AppConfig;
  onDismiss: () => void;
  onSuccess: (response: CreateCompetitorAccountResponse) => void;
}) {
  const t = useT();
  const labels = {
    aws: "AWS",
    gcp: "Google Cloud",
    azure: "Azure",
    sakura: t("cloud_connections.sakura"),
  };
  const [provider, setProvider] = useState<CloudProvider | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const nonAwsAvailable = !isLocalHost(config) && config.features?.nonAwsRuntime === true;
  const nonAwsMethod = nonAwsAvailable
    ? "cloud_connections.registration_only"
    : "cloud_connections.unavailable";
  const available = provider === "aws" || (provider !== null && nonAwsAvailable);
  const back = () => {
    setShowForm(false);
    setBusy(false);
  };
  const dismiss = () => {
    if (!busy) onDismiss();
  };

  if (showForm && provider === "aws") {
    return (
      <AddAccountModal
        config={config}
        visible
        onDismiss={onDismiss}
        onSuccess={onSuccess}
        onBack={back}
      />
    );
  }

  if (showForm && provider && provider !== "aws" && available) {
    return (
      <Modal
        visible
        size="large"
        header={`${t("cloud_connections.add")} — ${labels[provider]}`}
        onDismiss={dismiss}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button disabled={busy} onClick={back}>
                {t("cloud_connections.back")}
              </Button>
              <Button disabled={busy} onClick={dismiss}>
                {t("competitor_accounts.bulk_modal_close")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <TeamCloudCredentialsPanel
          key={provider}
          config={config}
          provider={provider}
          onBusyChange={setBusy}
        />
      </Modal>
    );
  }

  return (
    <Modal
      visible
      size="large"
      header={t("cloud_connections.add")}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDismiss}>{t("competitor_accounts.add_modal_cancel")}</Button>
            <Button variant="primary" disabled={!available} onClick={() => setShowForm(true)}>
              {t("cloud_connections.continue")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField
          label={t("cloud_connections.provider")}
          description={t("cloud_connections.choose_description")}
        >
          <Tiles
            value={provider}
            columns={2}
            items={PROVIDERS.map((p) => ({
              value: p,
              label: labels[p],
              description: t(p === "aws" ? "cloud_connections.aws_method" : nonAwsMethod),
            }))}
            onChange={(event) => setProvider(event.detail.value as CloudProvider)}
          />
        </FormField>
        {provider && provider !== "aws" && !available && (
          <Alert type="info">
            {t(
              isLocalHost(config)
                ? "cloud_connections.local_unavailable"
                : "cloud_connections.feature_unavailable",
            )}
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
