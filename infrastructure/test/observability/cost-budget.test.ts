import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CostBudget } from "../../lib/observability/cost-budget";

/**
 * Issue #952 / PR-957 CodeRabbit follow-up: CostBudget construct の振る舞いを pin する。
 * 特に「同一 email を 2 回以上渡しても SNS Subscription は 1 つだけ作られる」 ことを保証する
 * (= AWS 側で同じ宛先に 2 件の confirmation mail が飛ぶ事故を防ぐ)。
 */

describe("CostBudget", () => {
  it("budget と SNS topic を作成し、 default 閾値 80% / 100% で 2 件の Notification を生成すべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: ["alarm@example.com"],
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetType: "COST", TimeUnit: "MONTHLY" },
    });
    // notificationsWithSubscribers が 2 件 (= 80% / 100%) 含まれる
    const budgetProps = template.findResources("AWS::Budgets::Budget");
    const key = Object.keys(budgetProps)[0];
    if (!key) throw new Error("budget resource not found");
    const notifications = budgetProps[key]?.Properties?.NotificationsWithSubscribers as
      | Array<unknown>
      | undefined;
    expect(notifications).toBeDefined();
    expect(notifications?.length).toBe(2);
  });

  it("notificationEmails に重複があっても SNS Subscription は 1 件にまとまるべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: ["alarm@example.com", "alarm@example.com", "alarm@example.com"],
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::SNS::Subscription", 1);
  });

  it("notificationEmails が空でも construct 自体は壊れず、 Subscription は 0 件すべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: [],
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it("thresholdPercents 上書きで Notification 数が変わるべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: ["alarm@example.com"],
      thresholdPercents: [50, 80, 100],
    });

    const template = Template.fromStack(stack);
    const budgetProps = template.findResources("AWS::Budgets::Budget");
    const key = Object.keys(budgetProps)[0];
    if (!key) throw new Error("budget resource not found");
    const notifications = budgetProps[key]?.Properties?.NotificationsWithSubscribers as
      | Array<unknown>
      | undefined;
    expect(notifications?.length).toBe(3);
  });
});
