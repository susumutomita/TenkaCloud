import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import Textarea from "@cloudscape-design/components/textarea";
import { useState } from "react";
import { canMutateTenant, useApiClient } from "../../api/client";
import {
  type BulkCompetitorAccountResult,
  type BulkCreateCompetitorAccountsResponse,
  bulkCreateCompetitorAccounts,
} from "../../api/competitor-accounts-client";
import { FriendlyErrorAlert } from "../../components/FriendlyErrorAlert";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { deriveBulkInputState } from "../../lib/bulk-competitor-accounts";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";
import { defaultCompetitorRoleName } from "../../lib/resource-naming";

interface BulkImportModalProps {
  config: AppConfig;
  visible: boolean;
  onDismiss: () => void;
  /**
   * 登録要求が返ったときに呼ぶ (= 一覧を読み直す / 共有する 3 値を出す)。
   * `competitorRoleName` は実際に送った default (= 競技者へ渡す RoleName)。
   */
  onCompleted: (response: BulkCreateCompetitorAccountsResponse, competitorRoleName: string) => void;
}

const OUTCOME_INDICATOR: Record<
  BulkCompetitorAccountResult["outcome"],
  "success" | "warning" | "error"
> = {
  created: "success",
  duplicate: "warning",
  invalid: "error",
  failed: "error",
};

/**
 * JSON / アカウント ID の列を貼って複数 account をまとめて登録する。
 *
 * 結果は **行ごと**に出す。 backend が部分的な成功を正常系として返すので、 画面側で
 * 「全部成功」 か 「全部失敗」 に丸めると、 どの行が入ったのか分からなくなる。
 */
export function BulkImportModal({ config, visible, onDismiss, onCompleted }: BulkImportModalProps) {
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const t = useT();
  const suggestedRoleName = defaultCompetitorRoleName({ tenantId: config.tenantId });
  const [text, setText] = useState("");
  const [region, setRegion] = useState("ap-northeast-1");
  const [competitorRoleName, setCompetitorRoleName] = useState(suggestedRoleName);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [response, setResponse] = useState<BulkCreateCompetitorAccountsResponse | null>(null);

  const input = deriveBulkInputState(text, competitorRoleName);

  const reset = () => {
    setText("");
    setRegion("ap-northeast-1");
    setCompetitorRoleName(suggestedRoleName);
    setError(null);
    setResponse(null);
  };

  const handleDismiss = () => {
    // cancel / close button は disabled={inFlight} なので inFlight 中は呼ばれない
    // (= 防御的不到達、 AddAccountModal と同じ)。
    /* v8 ignore next */
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const submitDisabled = !apiClient || !canMutate || inFlight || !input.canSubmit;

  const handleSubmit = async () => {
    // submit button は disabled={submitDisabled} なので、 client 未取得や未 parse の
    // 状態では呼ばれない (= 防御的不到達)。
    /* v8 ignore next */
    if (!apiClient || !input.canSubmit) return;
    setInFlight(true);
    setError(null);
    try {
      // canSubmit の arm では roleName が 1 つに定まっている = 全行に実際に適用される
      // Role 名 = 競技者へ渡すべき値。
      const effectiveRoleName = input.roleName;
      const res = await bulkCreateCompetitorAccounts(apiClient, {
        // 画面の 2 つの入力を request の defaults にする。 貼り付けた JSON が行ごとに
        // 持っている値はそちらが優先される (backend 側で entry ?? defaults)。
        defaults: {
          region: input.pastedDefaults?.region ?? region,
          competitorRoleName: effectiveRoleName,
        },
        accounts: input.accounts,
      });
      setResponse(res);
      onCompleted(res, effectiveRoleName);
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
      header={t("competitor_accounts.bulk_modal_header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleDismiss} disabled={inFlight}>
              {response
                ? t("competitor_accounts.bulk_modal_close")
                : t("competitor_accounts.bulk_modal_cancel")}
            </Button>
            {!response && (
              <Button
                variant="primary"
                loading={inFlight}
                disabled={submitDisabled}
                onClick={() => void handleSubmit()}
              >
                {t("competitor_accounts.bulk_modal_submit")}
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && <FriendlyErrorAlert error={error} />}

        {response ? (
          <SpaceBetween size="m">
            <Alert
              type={response.created > 0 ? "success" : "warning"}
              header={t("competitor_accounts.bulk_result_header")}
            >
              {t("competitor_accounts.bulk_result_summary", {
                created: String(response.created),
                duplicate: String(response.duplicate),
                invalid: String(response.invalid + response.failed),
              })}
            </Alert>
            <Table
              variant="embedded"
              items={[...response.results]}
              columnDefinitions={[
                {
                  id: "awsAccountId",
                  header: "AWS Account ID",
                  cell: (item) => <code>{item.awsAccountId}</code>,
                },
                {
                  id: "outcome",
                  header: t("competitor_accounts.col_status"),
                  cell: (item) => (
                    <StatusIndicator type={OUTCOME_INDICATOR[item.outcome]}>
                      {t(`competitor_accounts.bulk_outcome_${item.outcome}`)}
                    </StatusIndicator>
                  ),
                },
                {
                  id: "message",
                  header: t("competitor_accounts.bulk_col_detail"),
                  cell: (item) => item.message ?? "",
                },
              ]}
            />
          </SpaceBetween>
        ) : (
          <SpaceBetween size="m">
            <FormField
              label={t("competitor_accounts.bulk_modal_input_label")}
              description={t("competitor_accounts.bulk_modal_input_description")}
              errorText={input.errors.length > 0 ? input.errors.join(" / ") : undefined}
              constraintText={
                input.canSubmit && input.accounts.length > 0
                  ? t("competitor_accounts.bulk_modal_parsed", {
                      count: String(input.accounts.length),
                    })
                  : undefined
              }
            >
              <Textarea
                value={text}
                onChange={(e) => setText(e.detail.value)}
                invalid={input.errors.length > 0}
                rows={10}
                disabled={inFlight}
                placeholder={"222222222222\n333333333333\n444444444444"}
              />
            </FormField>
            <FormField
              label={t("competitor_accounts.add_modal_region_label")}
              description={t("competitor_accounts.bulk_modal_region_description")}
            >
              <Input
                value={region}
                onChange={(e) => setRegion(e.detail.value)}
                disabled={inFlight}
              />
            </FormField>
            <FormField
              label={t("competitor_accounts.add_modal_role_label")}
              description={t("competitor_accounts.bulk_modal_role_description")}
            >
              <Input
                value={competitorRoleName}
                onChange={(e) => setCompetitorRoleName(e.detail.value)}
                disabled={inFlight}
              />
            </FormField>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Modal>
  );
}
