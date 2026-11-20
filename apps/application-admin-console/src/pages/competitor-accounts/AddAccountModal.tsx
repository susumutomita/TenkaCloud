import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { canManageConnections, useApiClient } from "../../api/client";
import {
  type CreateCompetitorAccountResponse,
  createCompetitorAccount,
  type SimulatorAuthorityInfo,
  type SimulatorConnectionInfo,
} from "../../api/competitor-accounts-client";
import { FriendlyErrorAlert } from "../../components/FriendlyErrorAlert";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";
import { defaultCompetitorRoleName } from "../../lib/resource-naming";
import { SimulatorConnectionNotice } from "./SimulatorConnectionNotice";

const ACCOUNT_ID_RE = /^\d{12}$/;
const ALIAS_MAX = 120;

interface AddAccountModalProps {
  config: AppConfig;
  simulator?: SimulatorConnectionInfo;
  authorities?: readonly SimulatorAuthorityInfo[];
  visible: boolean;
  onDismiss: () => void;
  onBack?: () => void;
  onSuccess: (res: CreateCompetitorAccountResponse) => void;
}

export function AddAccountModal({
  config,
  simulator,
  authorities,
  visible,
  onDismiss,
  onSuccess,
  onBack,
}: AddAccountModalProps) {
  const fixedSimulator = simulatorMode(simulator, authorities);
  const apiClient = useApiClient(config);
  const canMutate = canManageConnections(config, apiClient);
  const t = useT();
  // Issue #1314: Plane (= tenantId) scope を含む unique 名を default で提案する。
  // 同一競技者 AWS account を複数 Plane に並列接続できる (= 名前衝突しない)。
  const suggestedRoleName =
    simulator?.bootstrapRoleName ??
    config.competitorRoleName ??
    defaultCompetitorRoleName({ tenantId: config.tenantId });
  const [awsAccountId, setAwsAccountId] = useState(simulator?.awsAccountId ?? "");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState(
    simulator?.region ?? config.hostAwsRegion ?? "ap-northeast-1",
  );
  const [competitorRoleName, setCompetitorRoleName] = useState(suggestedRoleName);
  const [authorityId, setAuthorityId] = useState<string>();
  const authority = authorities?.find((entry) => authorityOptionKey(entry) === authorityId);
  const connectionRole = selectedRole(config, simulator, authority);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const reset = () => {
    setAwsAccountId(simulator?.awsAccountId ?? "");
    setAlias("");
    setRegion(simulator?.region ?? config.hostAwsRegion ?? "ap-northeast-1");
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
    aliasInvalid ||
    Boolean(authorities && !authority);

  const handleSubmit = async () => {
    // submit button は disabled={submitDisabled} なので呼ばれるのは送信可能時のみ (= 防御的不到達)。
    /* v8 ignore next */
    if (!apiClient || submitDisabled) return;
    setInFlight(true);
    setError(null);
    try {
      const res = await createCompetitorAccount(apiClient, {
        awsAccountId: authority?.awsAccountId ?? awsAccountId,
        region: authority?.region ?? region,
        ...(authority
          ? {
              simulatorAuthority: {
                authorityId: authority.authorityId,
                generation: authority.generation,
              },
            }
          : {}),
        competitorRoleName: connectionRole ?? competitorRoleName,
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
            {onBack && (
              <Button
                disabled={inFlight}
                onClick={() => {
                  reset();
                  onBack();
                }}
              >
                {t("cloud_connections.back")}
              </Button>
            )}
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
        <AuthoritySelect
          authorities={authorities}
          selected={authority}
          disabled={inFlight}
          onSelect={(entry) => {
            setAuthorityId(authorityOptionKey(entry));
            setAwsAccountId(entry.awsAccountId);
            setRegion(entry.region);
            setCompetitorRoleName(entry.bootstrapRoleName);
          }}
        />
        {simulator && <SimulatorConnectionNotice simulator={simulator} />}
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
            disabled={inFlight || fixedSimulator}
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
          <Input
            value={region}
            onChange={(e) => setRegion(e.detail.value)}
            disabled={inFlight || fixedSimulator || !!config.hostAwsRegion}
          />
        </FormField>
        <FormField
          label={t("competitor_accounts.add_modal_role_label")}
          description={t(
            config.competitorRoleName
              ? "competitor_accounts.configured_role_description"
              : "competitor_accounts.add_modal_role_description",
          )}
        >
          <Input
            value={connectionRole ?? competitorRoleName}
            onChange={(e) => setCompetitorRoleName(e.detail.value)}
            disabled={inFlight || fixedSimulator || !!config.competitorRoleName}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

function AuthoritySelect({
  authorities,
  selected,
  disabled,
  onSelect,
}: {
  authorities?: readonly SimulatorAuthorityInfo[];
  selected?: SimulatorAuthorityInfo;
  disabled: boolean;
  onSelect: (entry: SimulatorAuthorityInfo) => void;
}) {
  if (!authorities) return null;
  const option = (entry: SimulatorAuthorityInfo) => ({
    value: authorityOptionKey(entry),
    label: `${entry.authorityId} / ${entry.generation}`,
  });
  return (
    <FormField label="Simulator authority">
      <Select
        disabled={disabled}
        selectedOption={selected ? option(selected) : null}
        options={authorities.map(option)}
        onChange={({ detail }) => {
          const entry = authorities.find(
            (candidate) => authorityOptionKey(candidate) === detail.selectedOption.value,
          );
          if (entry) onSelect(entry);
        }}
      />
    </FormField>
  );
}

function simulatorMode(
  simulator?: SimulatorConnectionInfo,
  authorities?: readonly SimulatorAuthorityInfo[],
): boolean {
  return Boolean(simulator ?? authorities);
}
function selectedRole(
  config: AppConfig,
  simulator?: SimulatorConnectionInfo,
  authority?: SimulatorAuthorityInfo,
): string | undefined {
  return authority?.bootstrapRoleName ?? simulator?.bootstrapRoleName ?? config.competitorRoleName;
}

function authorityOptionKey(entry: SimulatorAuthorityInfo): string {
  return `${entry.authorityId}:${entry.generation}`;
}
