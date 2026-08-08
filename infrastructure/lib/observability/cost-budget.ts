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
  /**
   * Cost allocation tag filter (= Budget が拾う tag key/value)。
   * 例: \`{ Project: ["TenkaCloud"] }\` で App scope tag `Project=TenkaCloud` の付いたリソース
   * だけを集計対象にする。 user は AWS Billing console で 「Project」 を Cost Allocation Tag
   * として activate する必要がある (= 既存リソースへの遡及反映は最大 24h、 未 activate でも
   * Budget 自体は壊れないが filter が効かず全アカウント費用が対象になる)。
   * 未指定 (default) なら filter なし (= 全アカウント費用)。
   */
  readonly costAllocationTags?: Readonly<Record<string, readonly string[]>>;
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
    // 重複 email で同じ宛先に 2 重 subscription を作らないように Set で一意化する。
    for (const email of new Set(props.notificationEmails ?? [])) {
      this.topic.addSubscription(new aws_sns_subscriptions.EmailSubscription(email));
    }

    const subscribers: aws_budgets.CfnBudget.SubscriberProperty[] = [
      // SNS subscriber (= 通知本体)。 email は SNS subscription 側で配信。
      { subscriptionType: "SNS", address: this.topic.topicArn },
      // BudgetActions の SNS topic policy は AWS Budgets が自動で付ける (= 明示的 grant 不要)。
    ];

    // Cost allocation tag filter を CfnBudget の costFilters に変換する。
    //
    // AWS Budgets の costFilters の **key は固定語彙**で、 tag は `TagKeyValue` 1 つに集約
    // する。 tag 名を key にすると deploy 時に 400 で落ちる:
    //
    //   Unable to create/update budget - user:Project is not in the supported in cost budget
    //   dimension set: [PurchaseType, UsageTypeGroup, Service, Operation, UsageType,
    //   BillingEntity, CostCategory, LinkedAccount, TagKeyValue, LegalEntityName,
    //   InvoicingEntity, AZ, Region, InstanceType]
    //
    // `user:<Key>$<Value>` は **value 側**の書式である (Cost Explorer の dimension 名を
    // key に持ってくる形と混同しやすい)。 複数 tag / 複数 value はすべて同じ配列に並べる。
    //
    // 未指定なら costFilters ごと省き、 全リソースを集計する (= wire.ts が既定で
    // `Project=TenkaCloud` を渡すので、 実際に空になるのは明示的に外した場合だけ)。
    const tagFilterValues: string[] = [];
    for (const [tagKey, values] of Object.entries(props.costAllocationTags ?? {})) {
      for (const value of values) tagFilterValues.push(`user:${tagKey}$${value}`);
    }
    const tagFilters: Record<string, readonly string[]> =
      tagFilterValues.length > 0 ? { TagKeyValue: tagFilterValues } : {};

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
        // Cost allocation tag を渡されたときだけ filter を入れる (= 未指定なら全アカウント費用)。
        ...(Object.keys(tagFilters).length > 0 ? { costFilters: tagFilters } : {}),
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
