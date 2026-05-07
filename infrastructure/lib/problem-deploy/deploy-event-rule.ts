import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import {
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  EVENT_SOURCE,
} from "./handlers/shared/events";

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
 * State Machine と EventBridge Rule を別 construct に分けてあるのは、
 * `DeployUpdateRequested` / `DeployDeleteRequested` 等の他 detail-type が増えたとき
 * に Rule を独立に追加できるようにするため。
 */
export class DeployEventRule extends Construct {
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: DeployEventRuleProps) {
    super(scope, id);

    this.rule = new Rule(this, "Rule", {
      eventBus: props.eventBus,
      description: `Route ${EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED} events to DeployCreateStateMachine`,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: [EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED],
      },
      targets: [new SfnStateMachine(props.stateMachine)],
    });
  }
}

export interface DeployDeleteEventRuleProps {
  readonly eventBus: IEventBus;
  /** Rule の Target になる State Machine (= `DeployDeleteStateMachine`)。 */
  readonly stateMachine: IStateMachine;
}

/**
 * `DeployDeleteRequested` event を `DeployDeleteStateMachine` にルーティングする
 * EventBridge Rule。tenant API Lambda が削除要求時に publish し、本 Rule が
 * State Machine の `StartExecution` を呼ぶ。
 */
export class DeployDeleteEventRule extends Construct {
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: DeployDeleteEventRuleProps) {
    super(scope, id);

    this.rule = new Rule(this, "Rule", {
      eventBus: props.eventBus,
      description: `Route ${EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED} events to DeployDeleteStateMachine`,
      eventPattern: {
        source: [EVENT_SOURCE],
        detailType: [EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED],
      },
      targets: [new SfnStateMachine(props.stateMachine)],
    });
  }
}
