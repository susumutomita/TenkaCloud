import { CfnResource, type IAspect, RemovalPolicy } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export interface DestroyPolicySetterProps {
  /**
   * この Aspect が触らない CFn resource type (`AWS::DynamoDB::Table` 等)。
   *
   * #2959 の `CDK_PARAM_RETAIN_DATA_TABLES=true` のように、呼び出し側が明示的に「残す」と
   * 決めた resource を守るための逃げ道。既定は空 (= 全部 Delete に倒す)。
   */
  readonly skipResourceTypes?: readonly string[];
}

/**
 * stack 内の CfnResource を `DeletionPolicy: Delete` に倒す Aspect。destroy 後に resource が
 * 残って課金し続けるのを防ぐのが目的で、CDK 既定が RETAIN な LogGroup / UserPool / Bucket に効く。
 *
 * ## なぜ「明示 RETAIN を尊重する」実装にしないのか (#2960)
 *
 * 素直に考えると `cfnOptions.deletionPolicy === "Retain"` なら触らない、としたくなる。これは
 * **動かない**。CDK の L2 construct は既定の RETAIN も同じ `cfnOptions.deletionPolicy` に書くので、
 * 「CDK 既定で Retain になっているだけ」と「利用者が Retain と言った」がこの層では区別できない。
 * 区別できないまま尊重すると、この Aspect が塞ぎたい既定 RETAIN の穴がそのまま残る。
 *
 * したがって「守りたいもの」は呼び出し側が type で明示する (`skipResourceTypes`)。判断材料を
 * 持っているのは Aspect ではなく config を読む wire 側なので、そちらに置くのが正しい。
 */
export class DestroyPolicySetter implements IAspect {
  private readonly skip: ReadonlySet<string>;

  constructor(props: DestroyPolicySetterProps = {}) {
    this.skip = new Set(props.skipResourceTypes ?? []);
  }

  public visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;
    if (this.skip.has(node.cfnResourceType)) return;
    node.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}
