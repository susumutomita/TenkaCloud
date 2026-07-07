import { aws_budgets, Duration, Stack } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
  Unit,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export interface OpsMonitoringConfig {
  readonly alertEmail: string;
  readonly monthlyCostLimitUsd: number;
  readonly budgetThresholdPercent: number;
}

export interface OpsMonitoringProps extends OpsMonitoringConfig {
  readonly environmentName: string;
  readonly genericScoringLambda: IFunction;
}

/**
 * Issue #2406: event-ops alerting for scoring liveness/errors and monthly cost drift.
 *
 * The construct is created only when the operator supplies CDK_PARAM_OPS_ALERT_EMAIL. That keeps
 * idle/dev stacks from creating half-wired topics, alarms, or budgets with no confirmed receiver.
 */
export class OpsMonitoring extends Construct {
  public readonly topic: Topic;
  public readonly budget: aws_budgets.CfnBudget;
  public readonly scoringErrorAlarm: Alarm;
  public readonly scoringStoppedAlarm: Alarm;

  constructor(scope: Construct, id: string, props: OpsMonitoringProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const namePrefix = `tenkacloud-${props.environmentName}`;
    this.topic = new Topic(this, "AlertsTopic", {
      displayName: `${namePrefix} ops alerts`,
    });
    this.topic.addSubscription(new EmailSubscription(props.alertEmail));
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowBudgetsPublish",
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
        },
      }),
    );
    const actionName = new SnsAction(this.topic);

    this.scoringErrorAlarm = new Alarm(this, "GenericScoringErrorsAlarm", {
      alarmName: `${namePrefix}-generic-scoring-errors`,
      alarmDescription: "Generic scoring Lambda emitted Errors during the last 5 minutes.",
      metric: new Metric({
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensionsMap: { FunctionName: props.genericScoringLambda.functionName },
        statistic: "Sum",
        period: Duration.minutes(5),
        unit: Unit.COUNT,
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    this.scoringErrorAlarm.addAlarmAction(actionName);

    this.scoringStoppedAlarm = new Alarm(this, "GenericScoringStoppedAlarm", {
      alarmName: `${namePrefix}-generic-scoring-stopped`,
      alarmDescription:
        "Generic scoring Lambda has no scheduled invocations for 5 consecutive minutes.",
      metric: new Metric({
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensionsMap: { FunctionName: props.genericScoringLambda.functionName },
        statistic: "Sum",
        period: Duration.minutes(1),
        unit: Unit.COUNT,
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: TreatMissingData.BREACHING,
    });
    this.scoringStoppedAlarm.addAlarmAction(actionName);

    this.budget = new aws_budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: `${namePrefix}-ops-monthly-cost`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: props.monthlyCostLimitUsd,
          unit: "USD",
        },
        costTypes: {
          includeCredit: false,
          includeDiscount: true,
          includeOtherSubscription: true,
          includeRecurring: true,
          includeRefund: false,
          includeSubscription: true,
          includeSupport: false,
          includeTax: true,
          includeUpfront: false,
          useAmortized: false,
          useBlended: false,
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: props.budgetThresholdPercent,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "SNS", address: this.topic.topicArn }],
        },
      ],
    });
  }
}
