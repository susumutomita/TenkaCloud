import {
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketVersioningCommand,
  GetBucketLoggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

export interface S3CheckResult {
  check: string;
  passed: boolean;
  details: string;
}

export interface S3ScoringResult {
  bucketName: string;
  results: S3CheckResult[];
  totalScore: number;
  maxScore: number;
}

export interface S3ScoringCriteria {
  check: 'encryption' | 'public_access' | 'versioning' | 'logging';
  weight: number;
}

export async function checkEncryption(
  client: S3Client,
  bucketName: string
): Promise<S3CheckResult> {
  try {
    const result = await client.send(
      new GetBucketEncryptionCommand({ Bucket: bucketName })
    );

    const rules = result.ServerSideEncryptionConfiguration?.Rules ?? [];
    const hasEncryption = rules.length > 0;

    return {
      check: 'encryption',
      passed: hasEncryption,
      details: hasEncryption
        ? `暗号化ルール ${rules.length} 件が設定されています`
        : '暗号化が設定されていません',
    };
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ServerSideEncryptionConfigurationNotFoundError') {
      return {
        check: 'encryption',
        passed: false,
        details: '暗号化が設定されていません',
      };
    }
    throw error;
  }
}

export async function checkPublicAccess(
  client: S3Client,
  bucketName: string
): Promise<S3CheckResult> {
  try {
    const result = await client.send(
      new GetPublicAccessBlockCommand({ Bucket: bucketName })
    );

    const config = result.PublicAccessBlockConfiguration;
    const allBlocked =
      config?.BlockPublicAcls === true &&
      config?.IgnorePublicAcls === true &&
      config?.BlockPublicPolicy === true &&
      config?.RestrictPublicBuckets === true;

    return {
      check: 'public_access',
      passed: allBlocked,
      details: allBlocked
        ? 'パブリックアクセスが完全にブロックされています'
        : 'パブリックアクセスのブロックが不完全です',
    };
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'NoSuchPublicAccessBlockConfiguration') {
      return {
        check: 'public_access',
        passed: false,
        details: 'パブリックアクセスブロック設定がありません',
      };
    }
    throw error;
  }
}

export async function checkVersioning(
  client: S3Client,
  bucketName: string
): Promise<S3CheckResult> {
  const result = await client.send(
    new GetBucketVersioningCommand({ Bucket: bucketName })
  );

  const enabled = result.Status === 'Enabled';

  return {
    check: 'versioning',
    passed: enabled,
    details: enabled ? 'バージョニングが有効です' : 'バージョニングが無効です',
  };
}

export async function checkLogging(
  client: S3Client,
  bucketName: string
): Promise<S3CheckResult> {
  const result = await client.send(
    new GetBucketLoggingCommand({ Bucket: bucketName })
  );

  const hasLogging = result.LoggingEnabled != null;

  return {
    check: 'logging',
    passed: hasLogging,
    details: hasLogging
      ? `ログ出力先: ${result.LoggingEnabled?.TargetBucket ?? '不明'}`
      : 'ログ設定がありません',
  };
}

export async function evaluateBucket(
  client: S3Client,
  bucketName: string,
  criteria: S3ScoringCriteria[]
): Promise<S3ScoringResult> {
  const checkers: Record<
    string,
    (client: S3Client, bucket: string) => Promise<S3CheckResult>
  > = {
    encryption: checkEncryption,
    public_access: checkPublicAccess,
    versioning: checkVersioning,
    logging: checkLogging,
  };

  const results: S3CheckResult[] = [];
  let totalScore = 0;
  let maxScore = 0;

  for (const criterion of criteria) {
    const checker = checkers[criterion.check];
    if (!checker) {
      results.push({
        check: criterion.check,
        passed: false,
        details: `不明なチェック: ${criterion.check}`,
      });
      maxScore += criterion.weight;
      continue;
    }

    const result = await checker(client, bucketName);
    results.push(result);
    maxScore += criterion.weight;
    if (result.passed) {
      totalScore += criterion.weight;
    }
  }

  return { bucketName, results, totalScore, maxScore };
}
