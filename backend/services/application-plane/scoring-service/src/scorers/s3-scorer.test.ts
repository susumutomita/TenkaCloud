import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkEncryption,
  checkPublicAccess,
  checkVersioning,
  checkLogging,
  evaluateBucket,
} from './s3-scorer';

const mockSend = vi.fn();
const mockS3Client = { send: mockSend } as never;

describe('S3 スコアラー', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkEncryption', () => {
    it('暗号化が設定されている場合にpassedをtrueで返すべき', async () => {
      mockSend.mockResolvedValue({
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });

      const result = await checkEncryption(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(true);
      expect(result.check).toBe('encryption');
      expect(result.details).toContain('1 件');
    });

    it('暗号化ルールが空の場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({
        ServerSideEncryptionConfiguration: {
          Rules: [],
        },
      });

      const result = await checkEncryption(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
    });

    it('暗号化設定がない場合にpassedをfalseで返すべき', async () => {
      const error = new Error('Not found');
      (error as Error & { name: string }).name =
        'ServerSideEncryptionConfigurationNotFoundError';
      mockSend.mockRejectedValue(error);

      const result = await checkEncryption(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
      expect(result.details).toContain('設定されていません');
    });

    it('予期しないエラーは再スローするべき', async () => {
      mockSend.mockRejectedValue(new Error('Network error'));

      await expect(checkEncryption(mockS3Client, 'my-bucket')).rejects.toThrow(
        'Network error'
      );
    });

    it('ServerSideEncryptionConfigurationがundefinedの場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({});

      const result = await checkEncryption(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
    });
  });

  describe('checkPublicAccess', () => {
    it('全てのパブリックアクセスがブロックされている場合にpassedをtrueで返すべき', async () => {
      mockSend.mockResolvedValue({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      });

      const result = await checkPublicAccess(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(true);
      expect(result.details).toContain('完全にブロック');
    });

    it('一部のブロックが欠けている場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: true,
        },
      });

      const result = await checkPublicAccess(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
      expect(result.details).toContain('不完全');
    });

    it('パブリックアクセスブロック設定がない場合にpassedをfalseで返すべき', async () => {
      const error = new Error('Not found');
      (error as Error & { name: string }).name =
        'NoSuchPublicAccessBlockConfiguration';
      mockSend.mockRejectedValue(error);

      const result = await checkPublicAccess(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
      expect(result.details).toContain('設定がありません');
    });

    it('予期しないエラーは再スローするべき', async () => {
      mockSend.mockRejectedValue(new Error('Network error'));

      await expect(
        checkPublicAccess(mockS3Client, 'my-bucket')
      ).rejects.toThrow('Network error');
    });

    it('PublicAccessBlockConfigurationがundefinedの場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({});

      const result = await checkPublicAccess(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
    });
  });

  describe('checkVersioning', () => {
    it('バージョニングが有効な場合にpassedをtrueで返すべき', async () => {
      mockSend.mockResolvedValue({ Status: 'Enabled' });

      const result = await checkVersioning(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(true);
      expect(result.details).toContain('有効');
    });

    it('バージョニングが一時停止中の場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({ Status: 'Suspended' });

      const result = await checkVersioning(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
      expect(result.details).toContain('無効');
    });

    it('バージョニングのStatusがundefinedの場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({});

      const result = await checkVersioning(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
    });
  });

  describe('checkLogging', () => {
    it('ログ設定がある場合にpassedをtrueで返すべき', async () => {
      mockSend.mockResolvedValue({
        LoggingEnabled: {
          TargetBucket: 'log-bucket',
          TargetPrefix: 'logs/',
        },
      });

      const result = await checkLogging(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(true);
      expect(result.details).toContain('log-bucket');
    });

    it('ログ設定がない場合にpassedをfalseで返すべき', async () => {
      mockSend.mockResolvedValue({});

      const result = await checkLogging(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(false);
      expect(result.details).toContain('ログ設定がありません');
    });

    it('TargetBucketがundefinedの場合でもpassedをtrueで返すべき', async () => {
      mockSend.mockResolvedValue({
        LoggingEnabled: {},
      });

      const result = await checkLogging(mockS3Client, 'my-bucket');

      expect(result.passed).toBe(true);
      expect(result.details).toContain('不明');
    });
  });

  describe('evaluateBucket', () => {
    it('全てのチェックに合格した場合に満点を返すべき', async () => {
      // encryption
      mockSend.mockResolvedValueOnce({
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: {} }],
        },
      });
      // public_access
      mockSend.mockResolvedValueOnce({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      });

      const criteria = [
        { check: 'encryption' as const, weight: 25 },
        { check: 'public_access' as const, weight: 25 },
      ];

      const result = await evaluateBucket(mockS3Client, 'my-bucket', criteria);

      expect(result.totalScore).toBe(50);
      expect(result.maxScore).toBe(50);
      expect(result.results).toHaveLength(2);
      expect(result.bucketName).toBe('my-bucket');
    });

    it('一部のチェックに失敗した場合に部分スコアを返すべき', async () => {
      // encryption: pass
      mockSend.mockResolvedValueOnce({
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: {} }],
        },
      });
      // versioning: fail
      mockSend.mockResolvedValueOnce({ Status: 'Suspended' });

      const criteria = [
        { check: 'encryption' as const, weight: 50 },
        { check: 'versioning' as const, weight: 50 },
      ];

      const result = await evaluateBucket(mockS3Client, 'my-bucket', criteria);

      expect(result.totalScore).toBe(50);
      expect(result.maxScore).toBe(100);
    });

    it('不明なチェックタイプの場合に失敗として処理するべき', async () => {
      const criteria = [{ check: 'unknown_check' as never, weight: 25 }];

      const result = await evaluateBucket(mockS3Client, 'my-bucket', criteria);

      expect(result.totalScore).toBe(0);
      expect(result.maxScore).toBe(25);
      expect(result.results[0].passed).toBe(false);
      expect(result.results[0].details).toContain('不明なチェック');
    });

    it('空の基準リストの場合にスコア0を返すべき', async () => {
      const result = await evaluateBucket(mockS3Client, 'my-bucket', []);

      expect(result.totalScore).toBe(0);
      expect(result.maxScore).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });
});
