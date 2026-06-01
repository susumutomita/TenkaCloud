import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import Spinner from "@cloudscape-design/components/spinner";
import { usePolling } from "@tenkacloud/web-kit";
import { useCallback, useState } from "react";
import { type CostSummaryAvailable, fetchCostSummary } from "../api/insight";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { toErrorMessage } from "../lib/error-message";

// budget は AWS 側で日次更新されるため polling 圧は最小で十分 (= 5 分)。 DescribeBudget は無料。
const COST_POLL_INTERVAL_MS = 300_000;

type CostPanelView =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly summary: CostSummaryAvailable };

/** 金額を `12.34 USD` 形式に整形する (= 取得不能は em dash)。 */
export function formatBudgetAmount(value: number | null, unit: string): string {
  return value === null ? "—" : `${value.toFixed(2)} ${unit}`;
}

/** ProgressBar の status を消化率から決める (100% 以上で error 色 = 予算超過)。 */
export function budgetProgressStatus(percentConsumed: number | null): "in-progress" | "error" {
  return percentConsumed !== null && percentConsumed >= 100 ? "error" : "in-progress";
}

/**
 * Issue #1431: System Admin コンソールに「現在のコスト予算消化率」をインラインで出すパネル。
 *
 * admin-insight Lambda `GET /admin/insight/cost` (= AWS Budgets `DescribeBudget`、無料) を読み、
 * 消化率を ProgressBar + 金額一覧で表示する。 budget / 権限が未配線なら外部リンク誘導に留める
 * (= 親 OperationsPage の Budgets / Cost Explorer ボタン)。
 */
export function BudgetConsumptionPanel({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const [view, setView] = useState<CostPanelView>({ kind: "loading" });
  const idToken = auth.tokens?.idToken;

  const fetchOnce = useCallback(async () => {
    // usePolling は enabled=Boolean(idToken) なので token 無し時に発火しない (= この guard は不到達)。
    /* v8 ignore next */
    if (!idToken) return;
    try {
      const res = await fetchCostSummary(config, idToken);
      if (res?.available) {
        setView({ kind: "ready", summary: res });
      } else {
        setView({ kind: "unavailable" });
      }
    } catch (err) {
      setView({ kind: "error", message: toErrorMessage(err) });
    }
  }, [config, idToken]);

  usePolling(fetchOnce, COST_POLL_INTERVAL_MS, { enabled: Boolean(idToken) });

  if (view.kind === "loading") {
    return (
      <Box>
        <Spinner /> {t("operations.cost_loading")}
      </Box>
    );
  }
  if (view.kind === "error") {
    return (
      <Alert type="error" header={t("operations.cost_fetch_failed")}>
        {view.message}
      </Alert>
    );
  }
  if (view.kind === "unavailable") {
    return (
      <Box variant="small" color="text-status-inactive">
        {t("operations.cost_unavailable")}
      </Box>
    );
  }
  const { summary } = view;
  return (
    <>
      <ProgressBar
        value={summary.percentConsumed ?? 0}
        status={budgetProgressStatus(summary.percentConsumed)}
        label={t("operations.cost_consumed_label")}
      />
      <KeyValuePairs
        columns={3}
        items={[
          {
            label: t("operations.cost_limit_label"),
            value: formatBudgetAmount(summary.limitUsd, summary.unit),
          },
          {
            label: t("operations.cost_actual_label"),
            value: formatBudgetAmount(summary.actualSpendUsd, summary.unit),
          },
          {
            label: t("operations.cost_forecast_label"),
            value: formatBudgetAmount(summary.forecastedSpendUsd, summary.unit),
          },
        ]}
      />
    </>
  );
}
