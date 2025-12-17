import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

export interface FederationCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface ConsoleLoginUrl {
  url: string;
  expiresAt: Date;
}

/**
 * STS Federation Login for AWS Console
 *
 * 参加者が AWS Console にアクセスするための一時的な認証情報を生成します。
 * これにより、IAM ユーザーを作成せずに AWS リソースへのアクセスを提供できます。
 */
export class STSFederation {
  private stsClient: STSClient;
  private region: string;

  constructor(region: string = 'ap-northeast-1') {
    this.region = region;
    this.stsClient = new STSClient({ region });
  }

  /**
   * AssumeRole を使用して一時的な認証情報を取得
   */
  async assumeRole(
    roleArn: string,
    sessionName: string,
    durationSeconds: number = 3600
  ): Promise<FederationCredentials> {
    const command = new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: durationSeconds,
    });

    const response = await this.stsClient.send(command);

    if (
      !response.Credentials?.AccessKeyId ||
      !response.Credentials?.SecretAccessKey ||
      !response.Credentials?.SessionToken ||
      !response.Credentials?.Expiration
    ) {
      throw new Error('STS AssumeRole failed: No credentials returned');
    }

    return {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
      expiration: response.Credentials.Expiration,
    };
  }

  /**
   * Federation Login URL を生成
   *
   * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html
   */
  async generateConsoleLoginUrl(
    credentials: FederationCredentials,
    destination: string = 'https://console.aws.amazon.com/'
  ): Promise<ConsoleLoginUrl> {
    // Step 1: Create the session JSON
    const sessionJson = JSON.stringify({
      sessionId: credentials.accessKeyId,
      sessionKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    });

    // Step 2: Get sign-in token from federation endpoint
    const getSigninTokenUrl = new URL(
      'https://signin.aws.amazon.com/federation'
    );
    getSigninTokenUrl.searchParams.set('Action', 'getSigninToken');
    getSigninTokenUrl.searchParams.set(
      'SessionDuration',
      String(Math.floor((credentials.expiration.getTime() - Date.now()) / 1000))
    );
    getSigninTokenUrl.searchParams.set('Session', sessionJson);

    const signinTokenResponse = await fetch(getSigninTokenUrl.toString());
    if (!signinTokenResponse.ok) {
      throw new Error(
        `Failed to get signin token: ${signinTokenResponse.statusText}`
      );
    }

    const signinTokenData = (await signinTokenResponse.json()) as {
      SigninToken: string;
    };

    // Step 3: Create the console login URL
    const loginUrl = new URL('https://signin.aws.amazon.com/federation');
    loginUrl.searchParams.set('Action', 'login');
    loginUrl.searchParams.set('Issuer', 'TenkaCloud');
    loginUrl.searchParams.set('Destination', destination);
    loginUrl.searchParams.set('SigninToken', signinTokenData.SigninToken);

    return {
      url: loginUrl.toString(),
      expiresAt: credentials.expiration,
    };
  }

  /**
   * 参加者用の AWS Console アクセス URL を生成
   *
   * テナントごとに設定された IAM Role を使用して、
   * 参加者が AWS Console にアクセスできる URL を生成します。
   */
  async generateParticipantConsoleUrl(
    tenantId: string,
    participantId: string,
    battleId: string,
    roleArn: string,
    durationSeconds: number = 3600
  ): Promise<ConsoleLoginUrl> {
    const sessionName = `tc-${tenantId}-${participantId}-${battleId}`.substring(
      0,
      64
    );

    const credentials = await this.assumeRole(
      roleArn,
      sessionName,
      durationSeconds
    );

    return this.generateConsoleLoginUrl(credentials);
  }
}

/**
 * デフォルトの STS Federation インスタンス
 */
export const stsFederation = new STSFederation(
  process.env.AWS_REGION || 'ap-northeast-1'
);
