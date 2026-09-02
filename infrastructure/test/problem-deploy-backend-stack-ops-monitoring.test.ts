import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import {
  COORDINATION_BUDGET_EXCEEDED_EVENT,
  COORDINATION_BUDGET_WARNING_EVENT,
} from "../lib/problem-deploy/handlers/participant-handler/coordination-store";
import {
  SYNTH_TIMEOUT_MS,
  synthDefault,
  synthWithOpsMonitoring,
  synthWithOpsMonitoringAndPortal,
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

/**
 * [Issue #3151] "警告が実際に運営へ届く経路がある" — the acceptance criterion that a
 * log line alone does not satisfy.
 *
 * The budget check itself is unit-tested in
 * `problem-deploy/coordination-state-budget.test.ts`; what is asserted here is
 * the other half: that what it writes is turned into a metric and an alarm on
 * the same SNS topic (and therefore the same operator inbox) the scoring alarms
 * already use.
 */
describe("ProblemDeployBackendStack coordination state budget alerting (#3151)", () => {
  it(
    "should turn the budget log events into metrics on the dispatcher's log group",
    () => {
      const tpl = synthWithOpsMonitoringAndPortal();

      // Matching on the JSON `event` field, not on a substring of the rendered
      // line: a message that merely quoted the event name must not fire the
      // operator's alarm.
      for (const event of [COORDINATION_BUDGET_WARNING_EVENT, COORDINATION_BUDGET_EXCEEDED_EVENT]) {
        tpl.hasResourceProperties("AWS::Logs::MetricFilter", {
          FilterPattern: `{ $.event = "${event}" }`,
          LogGroupName: Match.anyValue(),
          MetricTransformations: Match.arrayWith([
            Match.objectLike({ MetricValue: "1", DefaultValue: 0 }),
          ]),
        });
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should alarm to the ops SNS topic on both the warning and the refusal",
    () => {
      const tpl = synthWithOpsMonitoringAndPortal();

      // Two separate alarms rather than one: "this match will stop unless
      // something changes" and "a match has already stopped" call for different
      // responses from whoever is woken up.
      for (const metricName of [
        "CoordinationStateBudgetWarnings",
        "CoordinationStateBudgetRefusals",
      ]) {
        tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
          MetricName: metricName,
          Namespace: "TenkaCloud/tenkacloud-development",
          Statistic: "Sum",
          Threshold: 0,
          ComparisonOperator: "GreaterThanThreshold",
          EvaluationPeriods: 1,
          AlarmActions: Match.anyValue(),
        });
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should create no coordination alarms in a stack that has no coordination dispatcher",
    () => {
      // The alarms follow the Lambda that writes coordination state. A stack
      // without a participant portal has no such Lambda, so watching for its
      // log group would create an alarm on a log group that never receives
      // anything — an alert that can only ever be silent.
      const tpl = synthWithOpsMonitoring();
      tpl.resourceCountIs("AWS::Logs::MetricFilter", 0);
      tpl.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should create no alerting at all when the operator configured no alert email",
    () => {
      // Same dormancy contract as the rest of this construct: no email, no
      // topic, and therefore nothing to alarm into.
      const tpl = synthDefault();
      tpl.resourceCountIs("AWS::Logs::MetricFilter", 0);
    },
    SYNTH_TIMEOUT_MS,
  );
});
