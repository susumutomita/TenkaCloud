import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type ActiveRecurringRow,
  cancelRecurringDisruption,
  fetchActiveRecurring,
} from "../../api/disruptions-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * 「実行中の定期障害」 セクション。 動作中の recurring を一覧し、 ワンタップで早期解除
 * する (= 「解除を毎回手でやるのめんどくさい」 の解消)。 一覧は mount 時に取得し、 定期 fire 直後は親が
 * `key` を変えて remount することで取り直す。定期 polling は行わず、操作起点の再取得だけで十分とする。
 * 何も走っていなければ section ごと隠す。DisruptionsPanel から分離して SRP/
 * file-size を保つ (Issue #986)。
 */
export function RecurringPanel({
  apiClient,
  canMutateTenant,
  eventId,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly eventId: string;
  readonly t: Translate;
}) {
  const [rows, setRows] = useState<readonly ActiveRecurringRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const reload = useCallback(async () => {
    /* v8 ignore next -- guarded by the effect's `if (!apiClient) return`; defensive. */
    if (!apiClient) return;
    const res = await fetchActiveRecurring(apiClient, eventId);
    setRows(res.items);
  }, [apiClient, eventId]);

  useEffect(() => {
    if (!apiClient) return;
    setError(null);
    reload().catch((err) => setError(toErrorMessage(err)));
  }, [apiClient, reload]);

  const onCancel = async (requestId: string) => {
    /* v8 ignore next -- defensive: rows only render after a successful fetch (apiClient present) and the button is disabled while a cancel is in-flight, so both guards are unreachable via the UI. */
    if (!apiClient || cancelling) return;
    setCancelling(requestId);
    setError(null);
    try {
      await cancelRecurringDisruption(apiClient, eventId, requestId);
      await reload();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setCancelling(null);
    }
  };

  if (rows.length === 0 && !error) return null;

  return (
    <SpaceBetween size="xs">
      <Header variant="h3">
        {t("disruptions.recurring_active_header", { count: rows.length })}
      </Header>
      {error ? <Alert type="error">{error}</Alert> : null}
      <Table
        variant="embedded"
        columnDefinitions={[
          {
            id: "disruptionId",
            header: t("disruptions.col_name"),
            cell: (r: ActiveRecurringRow) => r.disruptionId,
          },
          {
            id: "cadence",
            header: t("disruptions.recurring_cadence"),
            cell: (r: ActiveRecurringRow) => `${r.intervalMinutes}m × ${r.maxFires}`,
          },
          {
            id: "scope",
            header: t("disruptions.col_scope"),
            cell: (r: ActiveRecurringRow) => r.scope,
          },
          {
            id: "endsAt",
            header: t("disruptions.recurring_ends_at"),
            cell: (r: ActiveRecurringRow) => r.endsAt,
          },
          {
            id: "cancel",
            header: "",
            cell: (r: ActiveRecurringRow) => (
              <Button
                variant="inline-link"
                disabled={!canMutateTenant || cancelling === r.requestId}
                loading={cancelling === r.requestId}
                onClick={() => void onCancel(r.requestId)}
              >
                {t("disruptions.recurring_cancel")}
              </Button>
            ),
          },
        ]}
        items={rows}
      />
    </SpaceBetween>
  );
}
