import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ControlPlane } from '@cdklabs/sbt-aws';
import { Auth0Auth } from './auth0-auth';

export interface ControlPlaneStackProps extends StackProps {
  /** システム管理者メールアドレス */
  readonly systemAdminEmail: string;
  /** Auth0 テナントドメイン */
  readonly auth0Domain: string;
  /** Auth0 クライアント ID */
  readonly auth0ClientId: string;
  /** Auth0 クライアントシークレット */
  readonly auth0ClientSecret: string;
  /** Auth0 API Audience */
  readonly auth0Audience?: string;
}

/**
 * SBT ControlPlane スタック。
 *
 * Auth0 を認証プロバイダとして使用し、テナント管理 API と
 * EventBridge によるイベント連携を提供する。
 */
export class ControlPlaneStack extends Stack {
  readonly eventBusArn: string;
  readonly controlPlaneUrl: string;
  readonly clientId: string;
  readonly authorizationServer: string;
  readonly wellKnownEndpointUrl: string;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const auth0Auth = new Auth0Auth(this, 'Auth0Auth', {
      auth0Domain: props.auth0Domain,
      auth0ClientId: props.auth0ClientId,
      auth0ClientSecret: props.auth0ClientSecret,
      auth0Audience: props.auth0Audience ?? `https://api.tenkacloud.io`,
    });

    const controlPlane = new ControlPlane(this, 'ControlPlane', {
      systemAdminEmail: props.systemAdminEmail,
      auth: auth0Auth,
    });

    this.controlPlaneUrl = controlPlane.controlPlaneAPIGatewayUrl;
    this.eventBusArn = controlPlane.eventManager.busArn;
    this.clientId = auth0Auth.userClientId;
    this.wellKnownEndpointUrl = auth0Auth.wellKnownEndpointUrl;
    this.authorizationServer = `https://${props.auth0Domain}`;
  }
}
