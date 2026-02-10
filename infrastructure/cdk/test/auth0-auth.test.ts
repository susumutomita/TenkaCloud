import { describe, it, expect, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Auth0Auth, Auth0AuthProps } from '../lib/auth0-auth';

describe('Auth0Auth', () => {
  const defaultProps: Auth0AuthProps = {
    auth0Domain: 'tenkacloud-dev.us.auth0.com',
    auth0ClientId: 'test-client-id',
    auth0ClientSecret: 'test-client-secret',
    auth0Audience: 'https://api.tenkacloud.io',
    controlPlaneCallbackURL: 'https://localhost:3000/control/api/auth/callback',
  };

  function createAuth0Auth(props: Auth0AuthProps = defaultProps): Auth0Auth {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');
    return new Auth0Auth(stack, 'Auth0Auth', props);
  }

  it('IAuth インターフェースの必須プロパティを提供すべき', () => {
    const auth = createAuth0Auth();

    expect(auth.createUserFunction).toBeDefined();
    expect(auth.deleteUserFunction).toBeDefined();
    expect(auth.updateUserFunction).toBeDefined();
    expect(auth.fetchUserFunction).toBeDefined();
    expect(auth.fetchAllUsersFunction).toBeDefined();
    expect(auth.enableUserFunction).toBeDefined();
    expect(auth.disableUserFunction).toBeDefined();
  });

  it('JWT 関連のプロパティを正しく設定すべき', () => {
    const auth = createAuth0Auth();

    expect(auth.jwtIssuer).toBe(`https://${defaultProps.auth0Domain}/`);
    expect(auth.tokenEndpoint).toBe(
      `https://${defaultProps.auth0Domain}/oauth/token`
    );
    expect(auth.wellKnownEndpointUrl).toBe(
      `https://${defaultProps.auth0Domain}/.well-known/openid-configuration`
    );
    expect(auth.jwtAudience).toContain(defaultProps.auth0Audience);
  });

  it('クライアント ID を公開すべき', () => {
    const auth = createAuth0Auth();

    expect(auth.userClientId).toBe(defaultProps.auth0ClientId);
  });

  it('ユーザー管理 Lambda 関数を作成すべき', () => {
    const auth = createAuth0Auth();
    const template = cdk.assertions.Template.fromStack(
      cdk.Stack.of(auth.createUserFunction)
    );

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  it('Lambda 関数に Auth0 環境変数を設定すべき', () => {
    const auth = createAuth0Auth();
    const template = cdk.assertions.Template.fromStack(
      cdk.Stack.of(auth.createUserFunction)
    );

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          AUTH0_DOMAIN: defaultProps.auth0Domain,
          AUTH0_CLIENT_ID: defaultProps.auth0ClientId,
          AUTH0_AUDIENCE: defaultProps.auth0Audience,
        },
      },
    });
  });

  it('マシンクライアント認証情報を公開すべき', () => {
    const auth = createAuth0Auth();

    expect(auth.machineClientId).toBe(defaultProps.auth0ClientId);
    expect(auth.machineClientSecret).toBeDefined();
  });

  it('createAdminUser メソッドで CustomResource を作成すべき', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack2');
    const auth = new Auth0Auth(stack, 'Auth0Auth', defaultProps);

    auth.createAdminUser(stack, 'TestAdmin', {
      name: 'admin',
      email: 'admin@tenkacloud.io',
      role: 'SystemAdmin',
    });

    const template = cdk.assertions.Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      Email: 'admin@tenkacloud.io',
      Name: 'admin',
      Role: 'SystemAdmin',
    });
  });
});
