import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import {
  type CapacityOverview,
  type CapacityScaleAccepted,
  startCapacityScale,
} from "../../api/capacity-client";
import type { ApiClient } from "../../api/client";
import type { Translate } from "./tab-content-props";

/**
 * Issue #2680: 「キャパシティを変更」modal — Slice 1 の SSM runbook を `POST /admin/capacity`
 * 経由で起動する。CLI 実行と同じ document (= 同じ ceiling ガード + 実行履歴) を使うので、
 * この modal は入力 UI + ceiling の事前検証だけを担う。UpdateTable は非同期のため成功は
 * 202 accepted であり、反映は panel の 30 秒 polling で確認する。
 */

/** 1〜ceiling の整数でなければ true (backend の CapacityScaleBodySchema と同じ範囲)。 */
export function isCapacityUnitsInvalid(raw: string, ceiling: number): boolean {
  const value = Number(raw);
  return !Number.isInteger(value) || value < 1 || value > ceiling;
}

export function CapacityScaleModal({
  apiClient,
  overview,
  t,
  onClose,
  onAccepted,
}: {
  readonly apiClient: ApiClient;
  readonly overview: CapacityOverview;
  readonly t: Translate;
  readonly onClose: () => void;
  readonly onAccepted: (accepted: CapacityScaleAccepted) => void;
}) {
  const initial = overview.tables[0];
  const [tableName, setTableName] = useState<string>(initial ? initial.tableName : "");
  // 現行プロビジョン値を初期値にする (= 「今いくつか」を見ながら上げ下げできる)。
  const [rcu, setRcu] = useState<string>(initial ? String(initial.provisionedRead) : "1");
  const [wcu, setWcu] = useState<string>(initial ? String(initial.provisionedWrite) : "1");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const options = overview.tables.map((table) => ({
    value: table.tableName,
    label: `${t(`capacity.role_${table.role}`)} (${table.tableName})`,
  }));
  const selectedOption = options.find((o) => o.value === tableName) ?? null;

  const rcuInvalid = isCapacityUnitsInvalid(rcu, overview.ceiling);
  const wcuInvalid = isCapacityUnitsInvalid(wcu, overview.ceiling);
  const submitDisabled = submitting || tableName === "" || rcuInvalid || wcuInvalid;

  const confirmScale = async () => {
    /* v8 ignore next -- defensive: 実行 button は disabled={submitDisabled} なので到達しない */
    if (submitDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const accepted = await startCapacityScale(apiClient, {
        tableName,
        readCapacityUnits: Number(rcu),
        writeCapacityUnits: Number(wcu),
      });
      onAccepted(accepted);
    } catch (err) {
      setSubmitError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const constraint = t("capacity.scale_constraint", { ceiling: overview.ceiling });
  const invalidText = t("capacity.scale_invalid", { ceiling: overview.ceiling });

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={t("capacity.scale_modal_header")}
      data-testid="capacity-scale-modal"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onClose} disabled={submitting} data-testid="capacity-scale-cancel">
              {t("capacity.scale_cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmScale()}
              loading={submitting}
              disabled={submitDisabled}
              data-testid="capacity-scale-submit"
            >
              {t("capacity.scale_submit")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {submitError ? (
          <Alert type="error" data-testid="capacity-scale-error">
            {submitError}
          </Alert>
        ) : null}
        {/* scale-down は 1 日あたりの回数制限 (DynamoDB 仕様) + 反映は非同期、の 2 点を予告する。 */}
        <Alert type="warning" data-testid="capacity-scale-warning">
          {t("capacity.scale_warning")}
        </Alert>
        <FormField label={t("capacity.scale_table_label")}>
          <Select
            selectedOption={selectedOption}
            options={options}
            onChange={(e) => setTableName(e.detail.selectedOption.value as string)}
          />
        </FormField>
        <FormField
          label={t("capacity.scale_rcu_label")}
          constraintText={constraint}
          errorText={rcuInvalid ? invalidText : undefined}
        >
          <Input
            type="number"
            value={rcu}
            onChange={(e) => setRcu(e.detail.value)}
            ariaLabel={t("capacity.scale_rcu_label")}
          />
        </FormField>
        <FormField
          label={t("capacity.scale_wcu_label")}
          constraintText={constraint}
          errorText={wcuInvalid ? invalidText : undefined}
        >
          <Input
            type="number"
            value={wcu}
            onChange={(e) => setWcu(e.detail.value)}
            ariaLabel={t("capacity.scale_wcu_label")}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
