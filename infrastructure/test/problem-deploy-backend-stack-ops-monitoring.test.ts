import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithOpsMonitoring,
} from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack ops monitoring (#2406)", () => {
  it(
    "should skip the entire monitoring construct when the ops alert email is unset",
    () => {
      const tpl = synthDefault();

      tpl.resourceCountIs("AWS::SNS::Topic", 0);
      tpl.resourceCountIs("AWS::SNS::Subscription", 0);
      tpl.resourceCountIs("AWS::Budgets::Budget", 0);
      tpl.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should create one SNS topic, one email subscription, one budget, and two scoring alarms",
    () => {
      const tpl = synthWithOpsMonitoring();

      tpl.resourceCountIs("AWS::SNS::Topic", 1);
      tpl.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "ops@example.com",
      });
      tpl.resourceCountIs("AWS::Budgets::Budget", 1);
      tpl.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should alarm on GenericScoring Lambda Errors with the SNS topic action",
    () => {
      const tpl = synthWithOpsMonitoring();

      tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Errors",
        Namespace: "AWS/Lambda",
        Statistic: "Sum",
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        Period: 300,
        EvaluationPeriods: 1,
        Dimensions: Match.arrayWith([Match.objectLike({ Name: "FunctionName" })]),
        AlarmActions: Match.anyValue(),
      });
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should alarm when GenericScoring stops receiving scheduled invocations",
    () => {
      const tpl = synthWithOpsMonitoring();

      tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Invocations",
        Namespace: "AWS/Lambda",
        Statistic: "Sum",
        Threshold: 1,
        ComparisonOperator: "LessThanThreshold",
        Period: 60,
        EvaluationPeriods: 5,
        TreatMissingData: "breaching",
        Dimensions: Match.arrayWith([Match.objectLike({ Name: "FunctionName" })]),
        AlarmActions: Match.anyValue(),
      });
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should use the configured monthly budget amount and threshold",
    () => {
      const tpl = synthWithOpsMonitoring();

      tpl.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: {
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: 25, Unit: "USD" },
        },
        NotificationsWithSubscribers: [
          {
            Notification: {
              NotificationType: "ACTUAL",
              ComparisonOperator: "GREATER_THAN",
              Threshold: 90,
              ThresholdType: "PERCENTAGE",
            },
            Subscribers: [{ SubscriptionType: "SNS", Address: Match.anyValue() }],
          },
        ],
      });
    },
    SYNTH_TIMEOUT_MS,
  );
});
