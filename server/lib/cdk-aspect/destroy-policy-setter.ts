import { CfnResource, type IAspect, RemovalPolicy } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

export class DestroyPolicySetter implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnResource) {
      node.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
  }
}
