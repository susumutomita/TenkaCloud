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
  it("should create a budget and SNS topic, generating 2 Notifications at default thresholds 80% / 100%", () => {
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

  it("should collapse duplicate notificationEmails into a single SNS Subscription", () => {
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

  it("should keep the construct intact and have 0 Subscriptions when notificationEmails is empty", () => {
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

  it("overriding thresholdPercents should change the Notification count", () => {
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

  // Issue #952 / PR-957 user feedback: TenkaCloud リソースだけを集計するため、 user-defined
  // cost allocation tag (= App scope `Project=TenkaCloud`) で filter を絞る経路を pin する。
  it("should add `user:<Key>$<Value>` entries to CfnBudget CostFilters when costAllocationTags is passed", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: ["alarm@example.com"],
      costAllocationTags: { Project: ["TenkaCloud"] },
    });

    const template = Template.fromStack(stack);
    const budgetProps = template.findResources("AWS::Budgets::Budget");
    const key = Object.keys(budgetProps)[0];
    if (!key) throw new Error("budget resource not found");
    const budgetSpec = budgetProps[key]?.Properties?.Budget as Record<string, unknown>;
    const costFilters = budgetSpec?.CostFilters as Record<string, readonly string[]>;
    expect(costFilters).toBeDefined();
    expect(costFilters["user:Project"]).toEqual(["Project$TenkaCloud"]);
  });

  it("should omit the CostFilters key entirely when costAllocationTags is unset (all account spend counted)", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new CostBudget(stack, "Budget", {
      budgetNamePrefix: "tenkacloud-test",
      monthlyLimitUsd: 50,
      notificationEmails: ["alarm@example.com"],
    });

    const template = Template.fromStack(stack);
    const budgetProps = template.findResources("AWS::Budgets::Budget");
    const key = Object.keys(budgetProps)[0];
    if (!key) throw new Error("budget resource not found");
    const budgetSpec = budgetProps[key]?.Properties?.Budget as Record<string, unknown>;
    expect(budgetSpec?.CostFilters).toBeUndefined();
  });
});
