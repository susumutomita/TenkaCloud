import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted を使用してモックを正しくホイストする
const { mockSend, MockSTSClient, MockAssumeRoleCommand, getLastCommandParams } =
  vi.hoisted(() => {
    const mockSend = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastParams: any = null;

    class MockSTSClient {
      region: string;
      constructor(config: { region: string }) {
        this.region = config.region;
      }
      send = mockSend;
    }

    class MockAssumeRoleCommand {
      input: {
        RoleArn: string;
        RoleSessionName: string;
        DurationSeconds: number;
      };
      constructor(params: {
        RoleArn: string;
        RoleSessionName: string;
        DurationSeconds: number;
      }) {
        this.input = params;
        lastParams = params;
      }
    }

    const getLastCommandParams = () => lastParams;

    return {
      mockSend,
      MockSTSClient,
      MockAssumeRoleCommand,
      getLastCommandParams,
    };
  });

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: MockSTSClient,
  AssumeRoleCommand: MockAssumeRoleCommand,
}));

import { STSFederation, stsFederation } from '../sts-federation';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('STSFederation', () => {
  let federation: STSFederation;

  beforeEach(() => {
    vi.clearAllMocks();
    federation = new STSFederation('ap-northeast-1');
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('コンストラクタ', () => {
    it('デフォルトリージョンで初期化されるべき', () => {
      const defaultFederation = new STSFederation();
      expect(defaultFederation).toBeDefined();
    });

    it('指定されたリージョンで初期化されるべき', () => {
      const usFederation = new STSFederation('us-east-1');
      expect(usFederation).toBeDefined();
    });
  });

  describe('assumeRole', () => {
    it('有効な認証情報を返すべき', async () => {
      const expiration = new Date('2024-12-31T23:59:59Z');
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
          Expiration: expiration,
        },
      });

      const credentials = await federation.assumeRole(
        'arn:aws:iam::123456789012:role/TestRole',
        'test-session'
      );

      expect(credentials.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(credentials.secretAccessKey).toBe(
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      );
      expect(credentials.sessionToken).toBe('FwoGZXIvYXdzEBYaDExample');
      expect(credentials.expiration).toEqual(expiration);
    });

    it('カスタム有効期限を指定できるべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
          Expiration: new Date(),
        },
      });

      await federation.assumeRole(
        'arn:aws:iam::123456789012:role/TestRole',
        'test-session',
        7200
      );

      const params = getLastCommandParams();
      expect(params).toEqual({
        RoleArn: 'arn:aws:iam::123456789012:role/TestRole',
        RoleSessionName: 'test-session',
        DurationSeconds: 7200,
      });
    });

    it('認証情報が返されない場合エラーをスローすべき', async () => {
      mockSend.mockResolvedValue({});

      await expect(
        federation.assumeRole(
          'arn:aws:iam::123456789012:role/TestRole',
          'test-session'
        )
      ).rejects.toThrow('STS AssumeRole failed: No credentials returned');
    });

    it('AccessKeyId がない場合エラーをスローすべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
          Expiration: new Date(),
        },
      });

      await expect(
        federation.assumeRole(
          'arn:aws:iam::123456789012:role/TestRole',
          'test-session'
        )
      ).rejects.toThrow('STS AssumeRole failed: No credentials returned');
    });

    it('SecretAccessKey がない場合エラーをスローすべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
          Expiration: new Date(),
        },
      });

      await expect(
        federation.assumeRole(
          'arn:aws:iam::123456789012:role/TestRole',
          'test-session'
        )
      ).rejects.toThrow('STS AssumeRole failed: No credentials returned');
    });

    it('SessionToken がない場合エラーをスローすべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          Expiration: new Date(),
        },
      });

      await expect(
        federation.assumeRole(
          'arn:aws:iam::123456789012:role/TestRole',
          'test-session'
        )
      ).rejects.toThrow('STS AssumeRole failed: No credentials returned');
    });

    it('Expiration がない場合エラーをスローすべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
        },
      });

      await expect(
        federation.assumeRole(
          'arn:aws:iam::123456789012:role/TestRole',
          'test-session'
        )
      ).rejects.toThrow('STS AssumeRole failed: No credentials returned');
    });
  });

  describe('generateConsoleLoginUrl', () => {
    const mockCredentials = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'FwoGZXIvYXdzEBYaDExample',
      expiration: new Date(Date.now() + 3600000), // 1 hour from now
    };

    it('コンソールログイン URL を生成すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SigninToken: 'test-signin-token' }),
      });

      const result = await federation.generateConsoleLoginUrl(mockCredentials);

      expect(result.url).toContain('https://signin.aws.amazon.com/federation');
      expect(result.url).toContain('Action=login');
      expect(result.url).toContain('Issuer=TenkaCloud');
      expect(result.url).toContain('SigninToken=test-signin-token');
      expect(result.url).toContain(
        'Destination=' + encodeURIComponent('https://console.aws.amazon.com/')
      );
      expect(result.expiresAt).toEqual(mockCredentials.expiration);
    });

    it('カスタム宛先 URL を指定できるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SigninToken: 'test-signin-token' }),
      });

      const customDestination =
        'https://console.aws.amazon.com/s3/home?region=ap-northeast-1';
      const result = await federation.generateConsoleLoginUrl(
        mockCredentials,
        customDestination
      );

      expect(result.url).toContain(
        'Destination=' + encodeURIComponent(customDestination)
      );
    });

    it('Federation エンドポイントに正しいパラメータを送信すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SigninToken: 'test-signin-token' }),
      });

      await federation.generateConsoleLoginUrl(mockCredentials);

      expect(mockFetch).toHaveBeenCalled();
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('Action=getSigninToken');
      expect(calledUrl).toContain('SessionDuration=');
      expect(calledUrl).toContain('Session=');
    });

    it('サインイントークン取得に失敗した場合エラーをスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Unauthorized',
      });

      await expect(
        federation.generateConsoleLoginUrl(mockCredentials)
      ).rejects.toThrow('Failed to get signin token: Unauthorized');
    });
  });

  describe('generateParticipantConsoleUrl', () => {
    beforeEach(() => {
      const expiration = new Date(Date.now() + 3600000);
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'FwoGZXIvYXdzEBYaDExample',
          Expiration: expiration,
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ SigninToken: 'test-signin-token' }),
      });
    });

    it('参加者用のコンソール URL を生成すべき', async () => {
      const result = await federation.generateParticipantConsoleUrl(
        'tenant-123',
        'user-456',
        'battle-789',
        'arn:aws:iam::123456789012:role/ParticipantRole'
      );

      expect(result.url).toContain('https://signin.aws.amazon.com/federation');
      expect(result.expiresAt).toBeDefined();
    });

    it('セッション名を正しく生成すべき', async () => {
      await federation.generateParticipantConsoleUrl(
        'tenant-123',
        'user-456',
        'battle-789',
        'arn:aws:iam::123456789012:role/ParticipantRole'
      );

      const params = getLastCommandParams();
      expect(params.RoleSessionName).toBe('tc-tenant-123-user-456-battle-789');
    });

    it('セッション名が 64 文字を超えないようにすべき', async () => {
      const longTenantId = 'a'.repeat(30);
      const longParticipantId = 'b'.repeat(30);
      const longBattleId = 'c'.repeat(30);

      await federation.generateParticipantConsoleUrl(
        longTenantId,
        longParticipantId,
        longBattleId,
        'arn:aws:iam::123456789012:role/ParticipantRole'
      );

      const params = getLastCommandParams();
      expect(params.RoleSessionName).toBeDefined();
      expect(params.RoleSessionName.length).toBeLessThanOrEqual(64);
    });

    it('カスタム有効期限を指定できるべき', async () => {
      await federation.generateParticipantConsoleUrl(
        'tenant-123',
        'user-456',
        'battle-789',
        'arn:aws:iam::123456789012:role/ParticipantRole',
        7200
      );

      const params = getLastCommandParams();
      expect(params.DurationSeconds).toBe(7200);
    });
  });

  describe('デフォルト stsFederation インスタンス', () => {
    it('エクスポートされるべき', () => {
      expect(stsFederation).toBeDefined();
      expect(stsFederation).toBeInstanceOf(STSFederation);
    });
  });
});
