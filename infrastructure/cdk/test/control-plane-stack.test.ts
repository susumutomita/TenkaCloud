import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import {
  ControlPlaneStack,
  ControlPlaneStackProps,
} from '../lib/control-plane-stack';

describe('ControlPlaneStack', () => {
  function createStack(
    overrides?: Partial<ControlPlaneStackProps>
  ): ControlPlaneStack {
    // aws:cdk:bundling-stacks=[] を設定して Docker 不要のテストにする
    // SBT ControlPlane は内部で PythonFunction を使うため Docker bundling が必要だが
    // ユニットテストではスキップする
    const app = new cdk.App({
      context: {
        'aws:cdk:bundling-stacks': [],
      },
    });
    return new ControlPlaneStack(app, 'TestControlPlane', {
      systemAdminEmail: 'admin@tenkacloud.io',
      auth0Domain: 'tenkacloud-dev.us.auth0.com',
      auth0ClientId: 'test-client-id',
      auth0ClientSecret: 'test-client-secret',
      auth0Audience: 'https://api.tenkacloud.io',
      ...overrides,
    });
  }

  it('EventBridge の EventBus ARN を出力すべき', () => {
    const stack = createStack();
    expect(stack.eventBusArn).toBeDefined();
    expect(typeof stack.eventBusArn).toBe('string');
  });

  it('Control Plane API Gateway URL を出力すべき', () => {
    const stack = createStack();
    expect(stack.controlPlaneUrl).toBeDefined();
  });

  it('Auth0 クライアント ID を出力すべき', () => {
    const stack = createStack();
    expect(stack.clientId).toBe('test-client-id');
  });

  it('OIDC Well-Known エンドポイントを出力すべき', () => {
    const stack = createStack();
    expect(stack.wellKnownEndpointUrl).toBe(
      'https://tenkacloud-dev.us.auth0.com/.well-known/openid-configuration'
    );
  });

  it('認可サーバー URL を出力すべき', () => {
    const stack = createStack();
    expect(stack.authorizationServer).toBe(
      'https://tenkacloud-dev.us.auth0.com'
    );
  });

  it('Auth0Auth を認証プロバイダとして使用すべき', () => {
    const stack = createStack();
    const template = cdk.assertions.Template.fromStack(stack);

    // Auth0 user management Lambda functions should exist
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          AUTH0_DOMAIN: 'tenkacloud-dev.us.auth0.com',
        },
      },
    });
  });

  it('auth0Audience 未指定時はデフォルト値を使用すべき', () => {
    const stack = createStack({ auth0Audience: undefined });
    // Stack should still create successfully with default audience
    expect(stack.eventBusArn).toBeDefined();
    expect(stack.controlPlaneUrl).toBeDefined();
  });
});
