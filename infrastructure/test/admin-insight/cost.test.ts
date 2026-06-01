import { describe, expect, it, vi } from "vitest";
import {
  type CostDeps,
  getCostSummary,
} from "../../lib/admin-insight/handlers/admin-insight-handler/cost";

function buildDeps(send: ReturnType<typeof vi.fn>): CostDeps {
  return {
    budgets: { send: send as unknown as CostDeps["budgets"]["send"] },
    accountId: "123456789012",
    budgetName: "tenkacloud-development-monthly-cost",
  };
}

describe("getCostSummary", () => {
  it("should call DescribeBudget with the account id and budget name", async () => {
    const send = vi.fn().mockResolvedValue({
      Budget: {
        BudgetLimit: { Amount: "100", Unit: "USD" },
        CalculatedSpend: {
          ActualSpend: { Amount: "42", Unit: "USD" },
          ForecastedSpend: { Amount: "75", Unit: "USD" },
        },
      },
    });
    const out = await getCostSummary(buildDeps(send));
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = (send.mock.calls[0] as unknown[])[0] as {
      input: { AccountId: string; BudgetName: string };
    };
    expect(cmd.input.AccountId).toBe("123456789012");
    expect(cmd.input.BudgetName).toBe("tenkacloud-development-monthly-cost");
    expect(out).toEqual({
      limitUsd: 100,
      actualSpendUsd: 42,
      forecastedSpendUsd: 75,
      percentConsumed: 42,
      unit: "USD",
    });
  });

  it("should compute a rounded percentConsumed to one decimal place", async () => {
    const send = vi.fn().mockResolvedValue({
      Budget: {
        BudgetLimit: { Amount: "30", Unit: "USD" },
        CalculatedSpend: { ActualSpend: { Amount: "10" } },
      },
    });
    const out = await getCostSummary(buildDeps(send));
    expect(out.percentConsumed).toBe(33.3); // 10/30 = 33.33% → 33.3
    expect(out.forecastedSpendUsd).toBeNull();
  });

  it("should return null amounts and percent when the budget has no spend data", async () => {
    const send = vi.fn().mockResolvedValue({ Budget: {} });
    const out = await getCostSummary(buildDeps(send));
    expect(out).toEqual({
      limitUsd: null,
      actualSpendUsd: null,
      forecastedSpendUsd: null,
      percentConsumed: null,
      unit: "USD",
    });
  });

  it("should null percentConsumed when the limit is zero (avoid divide-by-zero)", async () => {
    const send = vi.fn().mockResolvedValue({
      Budget: {
        BudgetLimit: { Amount: "0", Unit: "USD" },
        CalculatedSpend: { ActualSpend: { Amount: "5" } },
      },
    });
    const out = await getCostSummary(buildDeps(send));
    expect(out.limitUsd).toBe(0);
    expect(out.percentConsumed).toBeNull();
  });

  it("should treat a non-numeric amount as null (defensive)", async () => {
    const send = vi.fn().mockResolvedValue({
      Budget: { BudgetLimit: { Amount: "not-a-number" } },
    });
    const out = await getCostSummary(buildDeps(send));
    expect(out.limitUsd).toBeNull();
    expect(out.unit).toBe("USD"); // BudgetLimit.Unit 欠落時の default
  });
});
