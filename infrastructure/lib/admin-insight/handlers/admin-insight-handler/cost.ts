import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";

/**
 * #1431: System Admin コンソールに「現在のコスト消化率」を出すための read-only handler。
 *
 * Cost Explorer (`GetCostAndUsage`) は 1 リクエスト約 $0.01 課金され cost-zero 原則に反するため、
 * **AWS Budgets `DescribeBudget`(無料)** で `CostBudget` 構築済みの月次予算とその実績 spend を読む。
 * 予算 / 権限が未配線のときは `available:false` を返し、 admin-console は外部リンク表示に留める。
 */

/** budgets client の最小 shape (= test で容易に mock)。 */
export interface CostDeps {
  readonly budgets: Pick<BudgetsClient, "send">;
  readonly accountId: string;
  readonly budgetName: string;
}

export function defaultBudgetsClient(): BudgetsClient {
  return new BudgetsClient({});
}

export interface CostSummary {
  /** 月次予算上限 (USD)。 取得不能なら null。 */
  readonly limitUsd: number | null;
  /** 当月の実績 spend (USD)。 取得不能なら null。 */
  readonly actualSpendUsd: number | null;
  /** 当月の予測 spend (USD)。 取得不能なら null。 */
  readonly forecastedSpendUsd: number | null;
  /** 予算消化率 (%)。 limit/actual が揃わなければ null。 */
  readonly percentConsumed: number | null;
  /** Free Tier (25 RCU/WCU 等) ではなく月次コスト予算に対する消化。 通貨単位。 */
  readonly unit: string;
}

function toAmount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 月次予算の実績消化を返す。 budget / IAM 未配線 (= accountId / budgetName 空、 ResourceNotFound) は
 * 全 null の summary を返し、 caller (route) が `available` を判定する。
 */
export async function getCostSummary(deps: CostDeps): Promise<CostSummary> {
  const out = await deps.budgets.send(
    new DescribeBudgetCommand({ AccountId: deps.accountId, BudgetName: deps.budgetName }),
  );
  const budget = out.Budget;
  const limitUsd = toAmount(budget?.BudgetLimit?.Amount);
  const actualSpendUsd = toAmount(budget?.CalculatedSpend?.ActualSpend?.Amount);
  const forecastedSpendUsd = toAmount(budget?.CalculatedSpend?.ForecastedSpend?.Amount);
  const percentConsumed =
    limitUsd !== null && limitUsd > 0 && actualSpendUsd !== null
      ? Math.round((actualSpendUsd / limitUsd) * 1000) / 10
      : null;
  return {
    limitUsd,
    actualSpendUsd,
    forecastedSpendUsd,
    percentConsumed,
    unit: budget?.BudgetLimit?.Unit ?? "USD",
  };
}
