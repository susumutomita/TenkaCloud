import { aws_budgets, aws_sns, aws_sns_subscriptions, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * Issue #952 epic / cost guardrails: AWS Budgets で 月次コストの天井を設定し、 alarm
 * threshold (80% / 100%) で SNS topic → email 通知する。 production / development の
 * default を分けて、 user は config.json で override 可能。
 *
 * 目的:
 *   - dev 環境で 検証用 deploy が放置されコスト爆発するのを早期検知する (= 80% で 1 回、
 *     100% で 2 回目の通知)
 *   - production で sudden spike (= 攻撃 / 設定ミス / runaway loop) に気付く
 *   - AWS Free Tier 内で運用する前提を破った瞬間を operator に伝える
 *
 * AWS Budgets 自体は **コストゼロ** (= 月 2 件まで free、 SNS 通知も 1,000 通までは無料)。
 * 設定するだけで作る価値あり。 阻止は出来ないが 「気付ける」 で十分な早期防御。
 */

export interface CostBudgetProps {
  /**
   * Budget の表示名 prefix。 default は \`tenkacloud-<env>\`。
   * Budget Name は account 内 unique なので env 別に分ける。
   */
  readonly budgetNamePrefix: string;
  /**
   * monthly limit (USD)。 production: 200、 development: 50 を default 想定。 config.json で override。
   */
  readonly monthlyLimitUsd: number;
  /**
   * 通知先 email。 SNS topic を作って subscribe する。
   * 未指定なら topic だけ作って subscription は別途 operator が AWS Console から追加する想定。
   */
  readonly notificationEmails?: readonly string[];
  /**
   * 通知 threshold (%)。 default は [80, 100]。
   */
  readonly thresholdPercents?: readonly number[];
}

/**
 * AWS Budgets + SNS topic を立てる Construct。 stack を跨いで参照不要なので observability
 * stack 配下に置く。 IAM は AWS Budgets が SNS publish を自動で持つので追加 grant 不要。
 */
export class CostBudget extends Construct {
  public readonly topic: aws_sns.Topic;
  public readonly budget: aws_budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: CostBudgetProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const thresholds = props.thresholdPercents ?? [80, 100];

    this.topic = new aws_sns.Topic(this, "BudgetAlarmTopic", {
      displayName: `${props.budgetNamePrefix} cost budget alarm`,
    });
    for (const email of props.notificationEmails ?? []) {
      this.topic.addSubscription(new aws_sns_subscriptions.EmailSubscription(email));
    }

    const subscribers: aws_budgets.CfnBudget.SubscriberProperty[] = [
      // SNS subscriber (= 通知本体)。 email は SNS subscription 側で配信。
      { subscriptionType: "SNS", address: this.topic.topicArn },
      // BudgetActions の SNS topic policy は AWS Budgets が自動で付ける (= 明示的 grant 不要)。
    ];

    this.budget = new aws_budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: `${props.budgetNamePrefix}-monthly-cost`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: props.monthlyLimitUsd,
          unit: "USD",
        },
        costTypes: {
          // Free Tier 控除を含めた **実 課金額** で評価する (= 操作実感に近い)。
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
      notificationsWithSubscribers: thresholds.map((threshold) => ({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold,
          thresholdType: "PERCENTAGE",
        },
        subscribers,
      })),
    });

    // CfnBudget は account-scoped (= region 不問) だが、 SNS topic は region 限定。
    // budget が複数 region に分散しないよう Stack.of(this).region 配下で 1 つだけ作る運用。
    void stack;
  }
}
