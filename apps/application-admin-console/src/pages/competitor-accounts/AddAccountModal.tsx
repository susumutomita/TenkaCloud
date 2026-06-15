import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { canMutateTenant, useApiClient } from "../../api/client";
import {
  type CreateCompetitorAccountResponse,
  createCompetitorAccount,
} from "../../api/competitor-accounts-client";
import { FriendlyErrorAlert } from "../../components/FriendlyErrorAlert";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";
import { defaultCompetitorRoleName } from "../../lib/resource-naming";

const ACCOUNT_ID_RE = /^\d{12}$/;
const ALIAS_MAX = 120;

interface AddAccountModalProps {
  config: AppConfig;
  visible: boolean;
  onDismiss: () => void;
  onSuccess: (res: CreateCompetitorAccountResponse) => void;
}

export function AddAccountModal({ config, visible, onDismiss, onSuccess }: AddAccountModalProps) {
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const t = useT();
  // Issue #1314: Plane (= tenantId) scope を含む unique 名を default で提案する。
  // 同一競技者 AWS account を複数 Plane に並列接続できる (= 名前衝突しない)。
  const suggestedRoleName = defaultCompetitorRoleName({ tenantId: config.tenantId });
  const [awsAccountId, setAwsAccountId] = useState("");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState("ap-northeast-1");
  const [competitorRoleName, setCompetitorRoleName] = useState(suggestedRoleName);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const reset = () => {
    setAwsAccountId("");
    setAlias("");
    setRegion("ap-northeast-1");
    setCompetitorRoleName(suggestedRoleName);
    setError(null);
  };

  const handleDismiss = () => {
    // cancel button は disabled={inFlight} なので inFlight 中は呼ばれない (= 防御的不到達)。
    /* v8 ignore next */
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const awsAccountIdInvalid = awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(awsAccountId);
  const aliasInvalid = alias.length > ALIAS_MAX;
  const submitDisabled =
    !apiClient ||
    !canMutate ||
    inFlight ||
    awsAccountId.length === 0 ||
    awsAccountIdInvalid ||
    aliasInvalid;

  const handleSubmit = async () => {
    // submit button は disabled={submitDisabled} なので呼ばれるのは送信可能時のみ (= 防御的不到達)。
    /* v8 ignore next */
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
