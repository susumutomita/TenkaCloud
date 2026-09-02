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
import type { IFunction, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
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
  private readonly namePrefix: string;
  private readonly alarmAction: SnsAction;

  constructor(scope: Construct, id: string, props: OpsMonitoringProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const namePrefix = `tenkacloud-${props.environmentName}`;
    this.namePrefix = namePrefix;
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
    this.alarmAction = actionName;

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

  /**
   * [Issue #3151] Turns the coordination state-budget log lines into alarms on
   * the same SNS topic the scoring alarms already use.
   *
   * ## Why this is a method and not another constructor prop
   *
   * The Lambda that writes coordination state is built by the participant-portal
   * subsystem, which is constructed AFTER the scoring subsystem that owns this
   * construct. Taking it as a prop would mean reordering the stack — a much
   * larger change than an explicit "and also watch this" call once the function
   * exists.
   *
   * ## Why a metric filter and not a metric the handler publishes
   *
   * The handler is on the participant request path and runs untrusted problem
   * plugins with deliberately minimal IAM. `cloudwatch:PutMetricData` there
   * would be a new permission on exactly the role the platform keeps narrow, to
   * carry information the handler is already writing to its log. The filter
   * reads that log from outside the blast radius instead.
   *
   * Two alarms, because the two events mean different things to whoever is
   * woken up: the warning is "this match will stop unless something changes",
   * with time left to change it; the refusal is "a match has already stopped".
   */
  public watchCoordinationStateBudget(props: CoordinationBudgetWatchProps): void {
    const namespace = `TenkaCloud/${this.namePrefix}`;
    for (const [id, spec] of [
      [
        "CoordinationStateBudgetWarning",
        {
          event: props.warningEvent,
          metricName: "CoordinationStateBudgetWarnings",
          alarmSuffix: "coordination-state-budget-warning",
          description:
            "A coordination match is past half of the state size budget for this backend. " +
            "It will stop when it reaches the ceiling; act while the match is still playable.",
        },
      ],
      [
        "CoordinationStateBudgetExceeded",
        {
          event: props.exceededEvent,
          metricName: "CoordinationStateBudgetRefusals",
          alarmSuffix: "coordination-state-budget-exceeded",
          description:
            "A coordination state write was refused for exceeding the backend's size budget. " +
            "That match cannot progress until its state fits.",
        },
      ],
    ] as const) {
      const filter = new MetricFilter(this, `${id}Filter`, {
        logGroup: props.coordinationDispatcher.logGroup,
        metricNamespace: namespace,
        metricName: spec.metricName,
        // The handler logs one JSON object per line (`handlers/shared/trace-log.ts`),
        // so the filter matches on the `event` field rather than on a substring
        // of the rendered line — a message that merely quoted the event name
        // would not fire it.
        filterPattern: FilterPattern.stringValue("$.event", "=", spec.event),
        metricValue: "1",
        defaultValue: 0,
      });
      const alarm = new Alarm(this, `${id}Alarm`, {
        alarmName: `${this.namePrefix}-${spec.alarmSuffix}`,
        alarmDescription: spec.description,
        metric: filter.metric({ statistic: "Sum", period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // `defaultValue: 0` means the filter publishes a zero for every quiet
        // period, so a missing datapoint here is a broken pipeline rather than a
        // healthy match. NOT_BREACHING keeps that from paging anyone, matching
        // how the scoring error alarm treats the same situation.
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(this.alarmAction);
    }
  }
}

/**
 * [Issue #3151] Where the coordination budget log lines come from, and which
 * event names to match.
 *
 * The event names are passed in rather than duplicated here because the handler
 * exports them (`coordination-store.ts`). A literal in this file would be a
 * second source of truth that no test would catch drifting: the alarm would
 * simply stop firing, which looks exactly like a platform with no over-budget
 * matches.
 */
export interface CoordinationBudgetWatchProps {
  /**
   * The Lambda whose log group carries the budget events. Concrete rather than
   * `IFunction` because the log group is the whole point and `IFunction` does
   * not expose one.
   */
  readonly coordinationDispatcher: LambdaFunction;
  /** `COORDINATION_BUDGET_WARNING_EVENT`. */
  readonly warningEvent: string;
  /** `COORDINATION_BUDGET_EXCEEDED_EVENT`. */
  readonly exceededEvent: string;
}
