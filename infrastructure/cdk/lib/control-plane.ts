import { CognitoAuth, ControlPlane } from '@cdklabs/sbt-aws';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ControlPlaneStack extends Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventBusArn: string;

  constructor(scope: Construct, id: string, props: any) {
    super(scope, id, props);
    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth');

  // 注意: 明示的に CloudWatch ログを無効化するためには(そして CloudWatch のコストを節約するためには),
  // disableAPILogging フラグを true に設定してください。
  const controlPlane = new ControlPlane(this, 'ControlPlane', {
      auth: cognitoAuth,
      systemAdminEmail: '',
      systemAdminRoleName: 'SystemAdmin',
      disableAPILogging: true,
    });
    this.eventBusArn = controlPlane.eventManager.busArn;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
  }
}
