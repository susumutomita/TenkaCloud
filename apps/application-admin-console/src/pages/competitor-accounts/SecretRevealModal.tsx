import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import type { CreateCompetitorAccountResponse } from "../../api/competitor-accounts-client";
import { CopyableField } from "../../components/CopyableField";
import { useT } from "../../i18n";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK,
} from "../../lib/competitor-bootstrap";

/** How long the "Copied" confirmation stays lit after copying the full payload. */
const COPIED_FEEDBACK_RESET_MS = 2_000;

interface SecretRevealModalProps {
  secret: CreateCompetitorAccountResponse | null;
  onDismiss: () => void;
  templateUrl?: string;
}

export function SecretRevealModal({ secret, onDismiss, templateUrl }: SecretRevealModalProps) {
  const t = useT();
  const [allCopied, setAllCopied] = useState(false);
  if (!secret) return null;
  const effectiveTemplateUrl =
    templateUrl && templateUrl.length > 0
      ? templateUrl
      : COMPETITOR_BOOTSTRAP_TEMPLATE_URL_FALLBACK;
  const payload = buildShareablePayload({
    tenkaCloudAccountId: secret.tenkaCloudAccountId,
    externalId: secret.externalId,
    competitorRoleName: secret.competitorRoleName,
    templateUrl,
  });
  const onCopyAll = async () => {
    await navigator.clipboard.writeText(payload);
    setAllCopied(true);
    setTimeout(() => setAllCopied(false), COPIED_FEEDBACK_RESET_MS);
  };
  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header={t("competitor_accounts.secret_modal_header")}
      footer={
        <Box float="right">
          <Button variant="primary" onClick={onDismiss}>
            {t("competitor_accounts.secret_modal_close")}
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="warning" header={t("competitor_accounts.secret_modal_warning_header")}>
          {t("competitor_accounts.secret_modal_warning_body")}
        </Alert>
        <SpaceBetween size="s">
          <Header variant="h3">{t("competitor_accounts.secret_modal_launch_header")}</Header>
          <Button
            variant="primary"
            href={buildLaunchStackUrl({
              tenkaCloudAccountId: secret.tenkaCloudAccountId,
              externalId: secret.externalId,
              competitorRoleName: secret.competitorRoleName,
              templateUrl,
            })}
            target="_blank"
            iconName="external"
            iconAlign="right"
          >
            {t("competitor_accounts.secret_modal_launch_button")}
          </Button>
          <Box variant="small" color="text-status-inactive">
            {t("competitor_accounts.secret_modal_launch_hint")}
          </Box>
        </SpaceBetween>
        <SpaceBetween size="s">
          <Header variant="h3">{t("competitor_accounts.secret_modal_copy_header")}</Header>
          <Button
            iconName={allCopied ? "status-positive" : "copy"}
            onClick={() => void onCopyAll()}
          >
            {allCopied
              ? t("competitor_accounts.secret_modal_copy_done")
              : t("competitor_accounts.secret_modal_copy_all")}
          </Button>
        </SpaceBetween>
        <div>
          <Box variant="awsui-key-label">{t("competitor_accounts.secret_modal_steps_header")}</Box>
          <ol>
            <li>{t("competitor_accounts.secret_modal_step_1")}</li>
            <li>{t("competitor_accounts.secret_modal_step_2")}</li>
          </ol>
        </div>
        <ExpandableSection
          headerText={t("competitor_accounts.secret_modal_manual_header")}
          variant="container"
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={1} variant="text-grid">
              <div>
                <Box variant="awsui-key-label">
                  TenkaCloud Account ID (= CFn Parameter <code>TenkaCloudAccountId</code>)
                </Box>
                <CopyableField
                  value={secret.tenkaCloudAccountId}
                  ariaLabel="Copy TenkaCloudAccountId"
                />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  ExternalId (= CFn Parameter <code>ExternalId</code>)
                </Box>
                <CopyableField value={secret.externalId} ariaLabel="Copy ExternalId" />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  Competitor Role Name (= CFn Parameter <code>RoleName</code>)
                </Box>
                <CopyableField value={secret.competitorRoleName} ariaLabel="Copy RoleName" />
              </div>
              <div>
                <Box variant="awsui-key-label">
                  {t("competitor_accounts.secret_modal_template_label")}
                </Box>
                <a href={effectiveTemplateUrl} target="_blank" rel="noreferrer noopener">
                  competitor-bootstrap.yaml (raw)
                </a>
              </div>
            </ColumnLayout>
            <Box variant="small" color="text-status-inactive">
              {t("competitor_accounts.secret_modal_manual_hint")}
            </Box>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Modal>
  );
}
