import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";

export const DEPLOY_EVENT_SOURCE = "tenkacloud.deploy" as const;
export const DEPLOY_CREATE_REQUESTED_DETAIL_TYPE = "DeployCreateRequested" as const;

export interface DeployEventRuleProps {
  /** SBT ControlPlane が払い出す共通 EventBus。 */
  readonly eventBus: IEventBus;
  /** Rule の Target になる State Machine (= `DeployCreateStateMachine`)。 */
  readonly stateMachine: IStateMachine;
}

/**
 * `DeployCreateRequested` event を `DeployCreateStateMachine` にルーティングする
 * EventBridge Rule (MVP-1)。
 *
 * tenant API Lambda が `events:PutEvents` で
 *   { source: "tenkacloud.deploy", detailType: "DeployCreateRequested", detail: {...} }
 * を publish すると、本 Rule が State Machine の `StartExecution` を呼ぶ。
 *
 * State Machine と EventBridge Rule を別 construct に分けてあるのは、Phase 2 で
 * `DeployUpdateRequested` / `DeployDeleteRequested` 等の他 detail-type が増えたとき
 * に Rule を独立に追加できるようにするため。
 */
export class DeployEventRule extends Construct {
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: DeployEventRuleProps) {
    super(scope, id);

    this.rule = new Rule(this, "Rule", {
      eventBus: props.eventBus,
      description: `Route ${DEPLOY_CREATE_REQUESTED_DETAIL_TYPE} events to DeployCreateStateMachine`,
      eventPattern: {
        source: [DEPLOY_EVENT_SOURCE],
        detailType: [DEPLOY_CREATE_REQUESTED_DETAIL_TYPE],
      },
      targets: [new SfnStateMachine(props.stateMachine)],
    });
  }
}
