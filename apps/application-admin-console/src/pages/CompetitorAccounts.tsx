import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { useEffect, useState } from "react";
import type {
  CompetitorAccountSummary,
  CreateCompetitorAccountResponse,
} from "../api/competitor-accounts-client";
import { FriendlyErrorAlert } from "../components/FriendlyErrorAlert";
import { LiteDrillCheckpointAlert } from "../components/LiteDrillCheckpointAlert";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { isBootstrapUrlMissing } from "../lib/competitor-bootstrap";
import { liteDrillCheckpointCode, markLiteDrillCheckpointShown } from "../lib/lite-drill";
import { AddAccountModal } from "./competitor-accounts/AddAccountModal";
import { CompetitorAccountDeleteModal } from "./competitor-accounts/CompetitorAccountDeleteModal";
import { CompetitorAccountsTable } from "./competitor-accounts/CompetitorAccountsTable";
import { SecretRevealModal } from "./competitor-accounts/SecretRevealModal";
import { TeamCloudCredentialsPanel } from "./competitor-accounts/TeamCloudCredentialsPanel";
import { useCompetitorAccounts } from "./competitor-accounts/useCompetitorAccounts";

export function CompetitorAccountsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const {
    items,
    error,
    verifyInFlight,
    deleteInFlight,
    canMutateTenant,
    lastVerified,
    clearLastVerified,
    reload,
    verify,
    remove,
  } = useCompetitorAccounts(config);
  // Issue #2696: Lite mode (tenantId="local") でだけ、 検証成功直後にオンボーディング
  // ドリルのチェックポイントコードを表示する。 一度表示したら二度と出さない (2026-07-21)。
  // `verify()` は setLastVerified → await reload() と 2 段の state 更新に分かれるため、
  // 毎 render で liteDrillCheckpointCode() を呼び直すと reload 後の再 render で
  // 「既に表示済み」 判定が効いて即座に Alert が消えてしまう (表示できたのは reload の
  // ネットワーク往復の間だけ)。 表示可否の判定は lastVerified が立った瞬間に 1 回だけ
  // effect 内で行い、 結果を local state に固定することでこの race を避ける。
  const [revealedDrillCode, setRevealedDrillCode] = useState<string | undefined>(undefined);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CompetitorAccountSummary | null>(null);
  const [showSecret, setShowSecret] = useState<CreateCompetitorAccountResponse | null>(null);

  useEffect(() => {
    if (!lastVerified) return;
    const code = liteDrillCheckpointCode(config, "competitorVerified");
    if (code) {
      setRevealedDrillCode(code);
      markLiteDrillCheckpointShown("competitorVerified");
    }
  }, [lastVerified, config]);

  const handleConfirmDelete = async () => {
    if (!canMutateTenant || !deleteTarget) return;
    const target = deleteTarget;
    await remove(target.awsAccountId);
    setDeleteTarget(null);
  };

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
          <Button
            variant="primary"
            disabled={!canMutateTenant}
            onClick={() => setAddModalVisible(true)}
          >
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

      {revealedDrillCode && (
        <LiteDrillCheckpointAlert
          code={revealedDrillCode}
          onDismiss={() => {
            setRevealedDrillCode(undefined);
            clearLastVerified();
          }}
        />
      )}

      <CompetitorAccountsTable
        items={items ?? []}
        verifyInFlight={verifyInFlight}
        canMutateTenant={canMutateTenant}
        onVerify={(awsAccountId) => void verify(awsAccountId)}
        onRequestDelete={setDeleteTarget}
        onAdd={() => setAddModalVisible(true)}
      />

      {/* Issue #1413: non-AWS (sakura/azure/gcp) per-team credential onboarding.
          Feature-flagged off until the non-AWS runtimes are verified end-to-end. */}
      {config.features?.nonAwsRuntime ? <TeamCloudCredentialsPanel config={config} /> : null}

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

      <CompetitorAccountDeleteModal
        target={deleteTarget}
        inFlight={deleteInFlight}
        canMutateTenant={canMutateTenant}
        onDismiss={() => setDeleteTarget(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </SpaceBetween>
  );
}
