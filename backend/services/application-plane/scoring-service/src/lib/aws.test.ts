import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation((config) => ({
    config,
    send: vi.fn(),
  })),
}));

import { assumeRole, createS3Client, createSTSClient } from './aws';

describe('AWS ヘルパー', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createSTSClient', () => {
    it('STSクライアントを作成できるべき', () => {
      const client = createSTSClient();
      expect(client).toBeDefined();
    });

    it('AWS_ENDPOINTが設定されている場合にエンドポイント付きで作成するべき', () => {
      process.env = { ...originalEnv, AWS_ENDPOINT: 'http://localhost:4566' };
      const client = createSTSClient();
      expect(client).toBeDefined();
    });
  });

  describe('assumeRole', () => {
    it('有効な認証情報を返すべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: 'AKIA123',
          SecretAccessKey: 'secret123',
          SessionToken: 'token123',
        },
      });

      const result = await assumeRole(
        'arn:aws:iam::123456:role/test-role',
        'test-session'
      );

      expect(result.accessKeyId).toBe('AKIA123');
      expect(result.secretAccessKey).toBe('secret123');
      expect(result.sessionToken).toBe('token123');
    });

    it('認証情報がない場合にエラーをスローするべき', async () => {
      mockSend.mockResolvedValue({ Credentials: {} });

      await expect(
        assumeRole('arn:aws:iam::123456:role/test-role', 'test-session')
      ).rejects.toThrow('AssumeRole で認証情報を取得できませんでした');
    });

    it('Credentialsがundefinedの場合にエラーをスローするべき', async () => {
      mockSend.mockResolvedValue({});

      await expect(
        assumeRole('arn:aws:iam::123456:role/test-role', 'test-session')
      ).rejects.toThrow('AssumeRole で認証情報を取得できませんでした');
    });

    it('AccessKeyIdがない場合にエラーをスローするべき', async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          SecretAccessKey: 'secret123',
          SessionToken: 'token123',
        },
      });

      await expect(
        assumeRole('arn:aws:iam::123456:role/test-role', 'test-session')
      ).rejects.toThrow('AssumeRole で認証情報を取得できませんでした');
    });
  });

  describe('createS3Client', () => {
    it('認証情報なしでS3クライアントを作成できるべき', () => {
      const client = createS3Client();
      expect(client).toBeDefined();
    });

    it('認証情報付きでS3クライアントを作成できるべき', () => {
      const credentials = {
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret123',
        sessionToken: 'token123',
      };

      const client = createS3Client(credentials);
      expect(client).toBeDefined();
    });

    it('AWS_ENDPOINTが設定されている場合にエンドポイント付きで作成するべき', () => {
      process.env = { ...originalEnv, AWS_ENDPOINT: 'http://localhost:4566' };
      const client = createS3Client();
      expect(client).toBeDefined();
    });
  });
});
