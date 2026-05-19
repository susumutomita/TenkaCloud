import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiClient } from "../api/client";
import {
  type CompetitorAccountSummary,
  type CreateCompetitorAccountResponse,
  createCompetitorAccount,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  verifyCompetitorAccount,
} from "../api/competitor-accounts-client";
import { CopyableField } from "../components/CopyableField";
import { FriendlyErrorAlert } from "../components/FriendlyErrorAlert";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import {
  buildLaunchStackUrl,
  buildShareablePayload,
  COMPETITOR_BOOTSTRAP_TEMPLATE_URL,
  isBootstrapUrlMissing,
} from "../lib/competitor-bootstrap";
import { type FriendlyError, toFriendlyError } from "../lib/friendly-error";

const ACCOUNT_ID_RE = /^\d{12}$/;
const ALIAS_MAX = 120;

export function CompetitorAccountsPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const t = useT();
  const [items, setItems] = useState<readonly CompetitorAccountSummary[] | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CompetitorAccountSummary | null>(null);
  const [verifyInFlight, setVerifyInFlight] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [showSecret, setShowSecret] = useState<CreateCompetitorAccountResponse | null>(null);

  const reload = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listCompetitorAccounts(apiClient);
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(toFriendlyError(err));
    }
  }, [apiClient]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleVerify = useCallback(
    async (awsAccountId: string) => {
      if (!apiClient) return;
      setVerifyInFlight(awsAccountId);
      try {
        await verifyCompetitorAccount(apiClient, awsAccountId);
        await reload();
      } catch (err) {
        setError(toFriendlyError(err));
      } finally {
        setVerifyInFlight(null);
      }
    },
    [apiClient, reload],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!apiClient || !deleteTarget) return;
    setDeleteInFlight(true);
    try {
      await deleteCompetitorAccount(apiClient, deleteTarget.awsAccountId);
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setDeleteInFlight(false);
    }
  }, [apiClient, deleteTarget, reload]);

  const columnDefinitions = useMemo<TableProps.ColumnDefinition<CompetitorAccountSummary>[]>(
    () => [
      {
        id: "awsAccountId",
        header: "AWS Account ID",
        cell: (item) => <code>{item.awsAccountId}</code>,
      },
      {
        id: "alias",
        header: t("competitor_accounts.col_alias"),
        cell: (item) =>
          item.alias ?? (
            <Box color="text-status-inactive">{t("competitor_accounts.alias_unset")}</Box>
          ),
      },
      {
        id: "region",
        header: "Region",
        cell: (item) => <code>{item.region}</code>,
      },
      {
        id: "competitorRoleName",
        header: t("competitor_accounts.col_role_name"),
        cell: (item) => <code>{item.competitorRoleName}</code>,
      },
      {
        id: "verified",
        header: t("competitor_accounts.col_status"),
        cell: (item) =>
          item.verified ? (
            <Badge color="green">Verified</Badge>
          ) : (
            <Badge color="red">Unverified</Badge>
          ),
      },
      {
        id: "actions",
        header: t("competitor_accounts.col_actions"),
        cell: (item) => (
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              loading={verifyInFlight === item.awsAccountId}
              disabled={verifyInFlight !== null}
              onClick={() => handleVerify(item.awsAccountId)}
            >
              {item.verified
                ? t("competitor_accounts.verify_again")
                : t("competitor_accounts.verify")}
            </Button>
            <Button variant="link" onClick={() => setDeleteTarget(item)}>
              {t("competitor_accounts.delete")}
            </Button>
          </SpaceBetween>
        ),
      },
    ],
    [handleVerify, verifyInFlight, t],
  );

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("competitor_accounts.loading_spinner")}
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("competitor_accounts.description")}
        actions={
          <Button variant="primary" onClick={() => setAddModalVisible(true)}>
            {t("competitor_accounts.add_button")}
          </Button>
        }
      >
        {t("competitor_accounts.title")}
      </Header>

      {isBootstrapUrlMissing(config.competitorBootstrapTemplateUrl) && (
        <Alert type="warning" header={t("competitor_accounts.bootstrap_url_missing_header")}>
          {t("competitor_accounts.bootstrap_url_missing_body")}
        </Alert>
      )}

      {error && <FriendlyErrorAlert error={error} />}

      <Table
        items={items ?? []}
        columnDefinitions={columnDefinitions}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {t("competitor_accounts.table_empty")}
          </Box>
        }
      />

      <AddAccountModal
        config={config}
        visible={addModalVisible}
        onDismiss={() => setAddModalVisible(false)}
        onSuccess={(res) => {
          setAddModalVisible(false);
          setShowSecret(res);
          void reload();
        }}
      />

      <SecretRevealModal
        secret={showSecret}
        onDismiss={() => setShowSecret(null)}
        templateUrl={config.competitorBootstrapTemplateUrl}
      />

      <Modal
        visible={deleteTarget !== null}
        onDismiss={() => setDeleteTarget(null)}
        header={t("competitor_accounts.delete_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleteTarget(null)} disabled={deleteInFlight}>
                {t("competitor_accounts.delete_modal_cancel")}
              </Button>
              <Button variant="primary" loading={deleteInFlight} onClick={handleConfirmDelete}>
                {t("competitor_accounts.delete_modal_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <p>
          {t("competitor_accounts.delete_modal_body_1", {
            accountId: deleteTarget?.awsAccountId ?? "",
          })}
        </p>
        <p>{t("competitor_accounts.delete_modal_body_2")}</p>
      </Modal>
    </SpaceBetween>
  );
}

interface AddAccountModalProps {
  config: AppConfig;
  visible: boolean;
  onDismiss: () => void;
  onSuccess: (res: CreateCompetitorAccountResponse) => void;
}

function AddAccountModal({ config, visible, onDismiss, onSuccess }: AddAccountModalProps) {
  const apiClient = useApiClient(config);
  const t = useT();
  const [awsAccountId, setAwsAccountId] = useState("");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState("ap-northeast-1");
  const [competitorRoleName, setCompetitorRoleName] = useState("TenkaCloud-CompetitorDeploy-Role");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const reset = () => {
    setAwsAccountId("");
    setAlias("");
    setRegion("ap-northeast-1");
    setCompetitorRoleName("TenkaCloud-CompetitorDeploy-Role");
    setError(null);
  };

  const handleDismiss = () => {
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const awsAccountIdInvalid = awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(awsAccountId);
  const aliasInvalid = alias.length > ALIAS_MAX;
  const submitDisabled =
    !apiClient || inFlight || awsAccountId.length === 0 || awsAccountIdInvalid || aliasInvalid;

  const handleSubmit = async () => {
    if (!apiClient || submitDisabled) return;
    setInFlight(true);
    setError(null);
    try {
      const res = await createCompetitorAccount(apiClient, {
        awsAccountId,
        region,
        competitorRoleName,
        ...(alias.length > 0 ? { alias } : {}),
      });
      reset();
      onSuccess(res);
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setInFlight(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={handleDismiss}
      header={t("competitor_accounts.add_modal_header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleDismiss} disabled={inFlight}>
              {t("competitor_accounts.add_modal_cancel")}
            </Button>
            <Button
              variant="primary"
              loading={inFlight}
              disabled={submitDisabled}
              onClick={handleSubmit}
            >
              {t("competitor_accounts.add_modal_submit")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && <FriendlyErrorAlert error={error} />}
        <FormField
          label={t("competitor_accounts.add_modal_account_id_label")}
          description={t("competitor_accounts.add_modal_account_id_description")}
          errorText={
            awsAccountIdInvalid ? t("competitor_accounts.add_modal_account_id_invalid") : undefined
          }
        >
          <Input
            value={awsAccountId}
            onChange={(e) => setAwsAccountId(e.detail.value)}
            invalid={awsAccountIdInvalid}
            placeholder="123456789012"
            disabled={inFlight}
          />
        </FormField>
        <FormField
          label={t("competitor_accounts.add_modal_alias_label")}
          description={t("competitor_accounts.add_modal_alias_description")}
        >
          <Input
            value={alias}
            onChange={(e) => setAlias(e.detail.value)}
            invalid={aliasInvalid}
            placeholder="Team Acme prod"
            disabled={inFlight}
          />
        </FormField>
        <FormField
          label={t("competitor_accounts.add_modal_region_label")}
          description={t("competitor_accounts.add_modal_region_description")}
        >
          <Input value={region} onChange={(e) => setRegion(e.detail.value)} disabled={inFlight} />
        </FormField>
        <FormField
          label={t("competitor_accounts.add_modal_role_label")}
          description={t("competitor_accounts.add_modal_role_description")}
        >
          <Input
            value={competitorRoleName}
            onChange={(e) => setCompetitorRoleName(e.detail.value)}
            disabled={inFlight}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

interface SecretRevealModalProps {
  secret: CreateCompetitorAccountResponse | null;
  onDismiss: () => void;
  templateUrl?: string;
}

function SecretRevealModal({ secret, onDismiss, templateUrl }: SecretRevealModalProps) {
  const t = useT();
  const [allCopied, setAllCopied] = useState(false);
  if (!secret) return null;
  const effectiveTemplateUrl =
    templateUrl && templateUrl.length > 0 ? templateUrl : COMPETITOR_BOOTSTRAP_TEMPLATE_URL;
  const payload = buildShareablePayload({
    tenkaCloudAccountId: secret.tenkaCloudAccountId,
    externalId: secret.externalId,
    competitorRoleName: secret.competitorRoleName,
    templateUrl,
  });
  const onCopyAll = async () => {
    await navigator.clipboard.writeText(payload);
    setAllCopied(true);
    setTimeout(() => setAllCopied(false), 2000);
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
