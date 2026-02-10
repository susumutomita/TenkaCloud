import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { IAuth, CreateAdminUserProps } from '@cdklabs/sbt-aws';

export interface Auth0AuthProps {
  /** Auth0 テナントドメイン (例: tenkacloud-dev.us.auth0.com) */
  readonly auth0Domain: string;
  /** Auth0 Machine-to-Machine アプリのクライアント ID */
  readonly auth0ClientId: string;
  /** Auth0 Machine-to-Machine アプリのクライアントシークレット */
  readonly auth0ClientSecret: string;
  /** Auth0 API Audience (例: https://api.tenkacloud.io) */
  readonly auth0Audience: string;
  /** Control Plane のコールバック URL */
  readonly controlPlaneCallbackURL?: string;
}

/**
 * Auth0 を SBT IAuth インターフェースに適合させるアダプター。
 *
 * SBT の ControlPlane は IAuth を通じてユーザー管理を行う。
 * このクラスは Auth0 Management API を呼び出す Lambda 関数群を作成し、
 * IAuth の全メソッド/プロパティを実装する。
 */
export class Auth0Auth extends Construct implements IAuth {
  readonly jwtIssuer: string;
  readonly jwtAudience: string[];
  readonly tokenEndpoint: string;
  readonly wellKnownEndpointUrl: string;
  readonly userClientId: string;
  readonly machineClientId: string;
  readonly machineClientSecret: cdk.SecretValue;

  readonly createUserFunction: lambda.IFunction;
  readonly deleteUserFunction: lambda.IFunction;
  readonly updateUserFunction: lambda.IFunction;
  readonly fetchUserFunction: lambda.IFunction;
  readonly fetchAllUsersFunction: lambda.IFunction;
  readonly enableUserFunction: lambda.IFunction;
  readonly disableUserFunction: lambda.IFunction;

  private readonly createAdminUserFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: Auth0AuthProps) {
    super(scope, id);

    this.jwtIssuer = `https://${props.auth0Domain}/`;
    this.tokenEndpoint = `https://${props.auth0Domain}/oauth/token`;
    this.wellKnownEndpointUrl = `https://${props.auth0Domain}/.well-known/openid-configuration`;
    this.jwtAudience = [props.auth0Audience];
    this.userClientId = props.auth0ClientId;
    this.machineClientId = props.auth0ClientId;

    const clientSecret = new secretsmanager.Secret(this, 'Auth0ClientSecret', {
      secretStringValue: cdk.SecretValue.unsafePlainText(
        props.auth0ClientSecret
      ),
      description: 'Auth0 M2M client secret for SBT ControlPlane',
    });
    this.machineClientSecret = clientSecret.secretValue;

    const commonEnv: Record<string, string> = {
      AUTH0_DOMAIN: props.auth0Domain,
      AUTH0_CLIENT_ID: props.auth0ClientId,
      AUTH0_AUDIENCE: props.auth0Audience,
      AUTH0_CLIENT_SECRET_ARN: clientSecret.secretArn,
    };

    const createLambda = (name: string, handler: string): lambda.Function => {
      const fn = new lambda.Function(this, name, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(
          generateAuth0Handler(handler, props.auth0Domain)
        ),
        timeout: cdk.Duration.seconds(30),
        environment: commonEnv,
        description: `Auth0 ${handler} - TenkaCloud SBT adapter`,
      });
      clientSecret.grantRead(fn);
      return fn;
    };

    this.createUserFunction = createLambda('CreateUserFunction', 'createUser');
    this.deleteUserFunction = createLambda('DeleteUserFunction', 'deleteUser');
    this.updateUserFunction = createLambda('UpdateUserFunction', 'updateUser');
    this.fetchUserFunction = createLambda('FetchUserFunction', 'fetchUser');
    this.fetchAllUsersFunction = createLambda(
      'FetchAllUsersFunction',
      'fetchAllUsers'
    );
    this.enableUserFunction = createLambda('EnableUserFunction', 'enableUser');
    this.disableUserFunction = createLambda(
      'DisableUserFunction',
      'disableUser'
    );

    this.createAdminUserFunction = createLambda(
      'CreateAdminUserFunction',
      'createAdminUser'
    );
  }

  createAdminUser(
    scope: Construct,
    id: string,
    props: CreateAdminUserProps
  ): void {
    new cdk.CustomResource(scope, `createAdminUserCustomResource-${id}`, {
      serviceToken: this.createAdminUserFunction.functionArn,
      properties: {
        Name: props.name,
        Email: props.email,
        Role: props.role,
      },
    });
  }
}

/**
 * Auth0 Management API を呼び出す Lambda ハンドラーのインラインコードを生成する。
 * 実運用では外部ファイルに切り出す。
 */
function generateAuth0Handler(operation: string, domain: string): string {
  return `
const https = require('https');

async function getManagementToken() {
  const secretArn = process.env.AUTH0_CLIENT_SECRET_ARN;
  const { SecretsManager } = require('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManager();
  const secret = await sm.getSecretValue({ SecretId: secretArn });
  const clientSecret = secret.SecretString;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: clientSecret,
      audience: 'https://' + process.env.AUTH0_DOMAIN + '/api/v2/',
      grant_type: 'client_credentials'
    });
    const req = https.request({
      hostname: process.env.AUTH0_DOMAIN,
      path: '/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(JSON.parse(body).access_token));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function auth0Request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.AUTH0_DOMAIN,
      path: '/api/v2' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  const token = await getManagementToken();
  const op = '${operation}';

  switch(op) {
    case 'createUser': {
      const { email, role, tenantId } = event;
      const result = await auth0Request('POST', '/users', {
        email, connection: 'Username-Password-Authentication',
        password: Math.random().toString(36) + 'Aa1!',
        app_metadata: { tenantId, role }
      }, token);
      return { statusCode: 200, body: result.body };
    }
    case 'deleteUser': {
      const { userId } = event;
      await auth0Request('DELETE', '/users/' + encodeURIComponent(userId), null, token);
      return { statusCode: 200 };
    }
    case 'updateUser': {
      const { userId, ...updates } = event;
      const result = await auth0Request('PATCH', '/users/' + encodeURIComponent(userId), updates, token);
      return { statusCode: 200, body: result.body };
    }
    case 'fetchUser': {
      const { userId } = event;
      const result = await auth0Request('GET', '/users/' + encodeURIComponent(userId), null, token);
      return { statusCode: 200, body: result.body };
    }
    case 'fetchAllUsers': {
      const result = await auth0Request('GET', '/users', null, token);
      return { statusCode: 200, body: result.body };
    }
    case 'enableUser': {
      const { userId } = event;
      await auth0Request('PATCH', '/users/' + encodeURIComponent(userId), { blocked: false }, token);
      return { statusCode: 200 };
    }
    case 'disableUser': {
      const { userId } = event;
      await auth0Request('PATCH', '/users/' + encodeURIComponent(userId), { blocked: true }, token);
      return { statusCode: 200 };
    }
    case 'createAdminUser': {
      const props = event.ResourceProperties || event;
      const { Email, Name, Role } = props;
      const requestType = event.RequestType;
      if (requestType === 'Delete') {
        return { PhysicalResourceId: event.PhysicalResourceId || 'admin-user', Status: 'SUCCESS' };
      }
      const result = await auth0Request('POST', '/users', {
        email: Email, connection: 'Username-Password-Authentication',
        password: require('crypto').randomBytes(16).toString('hex') + 'Aa1!',
        name: Name,
        app_metadata: { role: Role, isAdmin: true }
      }, token);
      return { PhysicalResourceId: result.body.user_id || 'admin-user', Status: 'SUCCESS' };
    }
  }
};
`;
}
