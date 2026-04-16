import { CognitoAuth, ControlPlane, type IEventManager } from "@cdklabs/sbt-aws";
import { Stack, type StackProps } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

export interface ControlPlaneStackProps extends StackProps {
  systemAdminEmail: string;
  systemAdminRoleName?: string;
  /** Enable Cognito Advanced Security Mode (default: true) */
  enableAdvancedSecurityMode?: boolean;
  /** Set API Gateway scopes for authorization (default: true) */
  setAPIGWScopes?: boolean;
  /** Disable CloudWatch API logging to reduce cost (default: false) */
  disableAPILogging?: boolean;
}

export class ControlPlaneStack extends Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventManager: IEventManager;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, "CognitoAuth", {
      enableAdvancedSecurityMode: props.enableAdvancedSecurityMode ?? true,
      setAPIGWScopes: props.setAPIGWScopes ?? true,
    });

    const controlPlane = new ControlPlane(this, "ControlPlane", {
      auth: cognitoAuth,
      systemAdminEmail: props.systemAdminEmail,
      systemAdminRoleName: props.systemAdminRoleName ?? "SystemAdmin",
      disableAPILogging: props.disableAPILogging ?? false,
    });

    this.eventManager = controlPlane.eventManager;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-L1",
        reason: "Lambda runtimes are managed by @cdklabs/sbt-aws and cannot be overridden",
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "Wildcard permissions in SBT ControlPlane are scoped to specific API paths (DELETE/PUT /tenants/*)",
      },
    ]);
  }
}
