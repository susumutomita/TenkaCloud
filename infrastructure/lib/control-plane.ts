import { CognitoAuth, ControlPlane } from '@cdklabs/sbt-aws';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface ControlPlaneStackProps extends StackProps {
  systemAdminEmail: string;
  systemAdminRoleName?: string;
  // CloudWatch API ログを無効化してコストを削減する（デフォルト: true）
  disableAPILogging?: boolean;
}

export class ControlPlaneStack extends Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventBusArn: string;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth');

    const controlPlane = new ControlPlane(this, 'ControlPlane', {
      auth: cognitoAuth,
      systemAdminEmail: props.systemAdminEmail,
      systemAdminRoleName: props.systemAdminRoleName ?? 'SystemAdmin',
      disableAPILogging: props.disableAPILogging ?? true,
    });

    this.eventBusArn = controlPlane.eventManager.busArn;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
  }
}
