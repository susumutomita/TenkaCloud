/**
 * AWS GameDay Scoring Provider
 *
 * AWS リソースの状態を検証してスコアを計算する採点プロバイダー
 */

import type { CloudCredentials, Problem, ScoringCriterion } from '../../types';
import type { IScoringExecutor, ScoringExecutionResult } from '../engine';

// =============================================================================
// Validation Config Types
// =============================================================================

interface EC2ValidationConfig {
  minCount?: number;
  state?: string;
  instanceType?: string;
}

interface S3ValidationConfig {
  bucketName?: string;
  versioning?: boolean;
  encryption?: boolean;
}

interface LambdaValidationConfig {
  functionName?: string;
  runtime?: string;
}

interface CloudFormationValidationConfig {
  stackName?: string;
}

interface VPCValidationConfig {
  minSubnets?: number;
}

interface SecurityGroupValidationConfig {
  prohibitedPorts?: number[];
  requirePrivate?: boolean;
}

interface IAMValidationConfig {
  roleName?: string;
  prohibitedActions?: string[];
}

interface CloudWatchValidationConfig {
  minAlarms?: number;
  metrics?: string[];
}

interface APIGatewayValidationConfig {
  apiName?: string;
}

// =============================================================================
// Core Types
// =============================================================================

/**
 * 検証結果
 */
interface ValidationResult {
  passed: boolean;
  score: number;
  maxScore: number;
  feedback: string;
  details?: Record<string, unknown>;
}

/**
 * リソース検証関数の型
 */
type ResourceValidator = (
  criterion: ScoringCriterion,
  credentials: CloudCredentials,
  competitorAccountId: string,
  context: ValidationContext
) => Promise<ValidationResult>;

/**
 * 検証コンテキスト
 */
interface ValidationContext {
  problemId: string;
  region: string;
  stackOutputs?: Record<string, string>;
}

/**
 * AWS GameDay 採点プロバイダー
 *
 * CloudFormation スタック、EC2、S3、Lambda などのリソース状態を検証
 */
export class AWSGameDayScoringProvider implements IScoringExecutor {
  readonly type = 'aws-gameday';

  private validators: Map<string, ResourceValidator> = new Map();

  constructor() {
    this.registerDefaultValidators();
  }

  /**
   * 採点実行
   */
  async execute(
    problem: Problem,
    credentials: CloudCredentials,
    competitorAccountId: string
  ): Promise<ScoringExecutionResult> {
    const startTime = Date.now();

    const context: ValidationContext = {
      problemId: problem.id,
      region: credentials.region,
    };

    // スタック出力を取得（あれば）
    try {
      context.stackOutputs = await this.getStackOutputs(
        `tenkacloud-${problem.id}-${competitorAccountId}`,
        credentials
      );
    } catch {
      // スタック出力が取得できない場合は続行
    }

    const criteriaResults: ScoringExecutionResult['criteriaResults'] = [];

    // 各採点基準を検証
    for (const criterion of problem.scoring.criteria) {
      const result = await this.validateCriterion(
        criterion,
        credentials,
        competitorAccountId,
        context
      );

      criteriaResults.push({
        name: criterion.name,
        points: result.score,
        maxPoints: result.maxScore,
        passed: result.passed,
        feedback: result.feedback,
      });
    }

    const totalScore = criteriaResults.reduce((sum, r) => sum + r.points, 0);
    const maxPossibleScore = criteriaResults.reduce(
      (sum, r) => sum + r.maxPoints,
      0
    );

    return {
      totalScore,
      maxPossibleScore,
      criteriaResults,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 基準の検証
   */
  private async validateCriterion(
    criterion: ScoringCriterion,
    credentials: CloudCredentials,
    competitorAccountId: string,
    context: ValidationContext
  ): Promise<ValidationResult> {
    // 検証タイプを決定
    const validationType =
      criterion.validationType || this.inferValidationType(criterion);
    const validator = this.validators.get(validationType);

    if (!validator) {
      return {
        passed: false,
        score: 0,
        maxScore: criterion.maxPoints,
        feedback: `Unknown validation type: ${validationType}`,
      };
    }

    try {
      return await validator(
        criterion,
        credentials,
        competitorAccountId,
        context
      );
    } catch (error) {
      return {
        passed: false,
        score: 0,
        maxScore: criterion.maxPoints,
        feedback: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 検証タイプを推測
   */
  private inferValidationType(criterion: ScoringCriterion): string {
    const nameLower = criterion.name.toLowerCase();
    const descLower = criterion.description?.toLowerCase() || '';
    const combined = `${nameLower} ${descLower}`;

    if (combined.includes('ec2') || combined.includes('instance')) {
      return 'ec2-instance';
    }
    if (combined.includes('s3') || combined.includes('bucket')) {
      return 's3-bucket';
    }
    if (combined.includes('lambda') || combined.includes('function')) {
      return 'lambda-function';
    }
    if (combined.includes('rds') || combined.includes('database')) {
      return 'rds-instance';
    }
    if (combined.includes('vpc') || combined.includes('network')) {
      return 'vpc-config';
    }
    if (
      combined.includes('iam') ||
      combined.includes('role') ||
      combined.includes('policy')
    ) {
      return 'iam-policy';
    }
    if (
      combined.includes('cloudwatch') ||
      combined.includes('alarm') ||
      combined.includes('monitoring')
    ) {
      return 'cloudwatch-alarm';
    }
    if (
      combined.includes('security') ||
      combined.includes('sg') ||
      combined.includes('firewall')
    ) {
      return 'security-group';
    }
    if (combined.includes('api') || combined.includes('gateway')) {
      return 'api-gateway';
    }
    if (combined.includes('cloudformation') || combined.includes('stack')) {
      return 'cloudformation-stack';
    }

    return 'generic';
  }

  /**
   * デフォルト検証関数の登録
   */
  private registerDefaultValidators(): void {
    // EC2 インスタンス検証
    this.validators.set(
      'ec2-instance',
      async (criterion, credentials, accountId, context) => {
        const instances = await this.describeEC2Instances(
          credentials,
          context.region,
          accountId
        );

        // 要件を解析
        const config = (criterion.validationConfig ||
          {}) as EC2ValidationConfig;
        const requiredCount = config.minCount ?? 1;
        const requiredState = config.state ?? 'running';
        const requiredType = config.instanceType;

        const matchingInstances = instances.filter((instance) => {
          if (instance.state !== requiredState) return false;
          if (requiredType && instance.instanceType !== requiredType)
            return false;
          return true;
        });

        const passed = matchingInstances.length >= requiredCount;
        const ratio = Math.min(matchingInstances.length / requiredCount, 1);

        return {
          passed,
          score: Math.round(criterion.maxPoints * ratio),
          maxScore: criterion.maxPoints,
          feedback: passed
            ? `✓ ${matchingInstances.length} 個の ${requiredState} インスタンスを検出`
            : `✗ ${requiredCount} 個以上の ${requiredState} インスタンスが必要 (現在: ${matchingInstances.length})`,
        };
      }
    );

    // S3 バケット検証
    this.validators.set(
      's3-bucket',
      async (criterion, credentials, _accountId, context) => {
        const buckets = await this.listS3Buckets(credentials, context.region);

        const config = (criterion.validationConfig || {}) as S3ValidationConfig;
        const requiredName = config.bucketName;
        const requiredVersioning = config.versioning;
        const requiredEncryption = config.encryption;

        const matchingBucket = buckets.find((b) =>
          requiredName ? b.name.includes(requiredName) : true
        );

        if (!matchingBucket) {
          return {
            passed: false,
            score: 0,
            maxScore: criterion.maxPoints,
            feedback: `✗ S3 バケットが見つかりません${requiredName ? `: ${requiredName}` : ''}`,
          };
        }

        let score = criterion.maxPoints * 0.5; // バケット存在で半分
        const checks: string[] = [];

        if (requiredVersioning !== undefined) {
          if (matchingBucket.versioning === requiredVersioning) {
            score += criterion.maxPoints * 0.25;
            checks.push('✓ バージョニング設定');
          } else {
            checks.push('✗ バージョニング未設定');
          }
        }

        if (requiredEncryption !== undefined) {
          if (matchingBucket.encryption === requiredEncryption) {
            score += criterion.maxPoints * 0.25;
            checks.push('✓ 暗号化設定');
          } else {
            checks.push('✗ 暗号化未設定');
          }
        }

        return {
          passed: score >= criterion.maxPoints * 0.75,
          score: Math.round(score),
          maxScore: criterion.maxPoints,
          feedback:
            checks.length > 0 ? checks.join(', ') : `✓ S3 バケット検証完了`,
        };
      }
    );

    // Lambda 関数検証
    this.validators.set(
      'lambda-function',
      async (criterion, credentials, _accountId, context) => {
        const functions = await this.listLambdaFunctions(
          credentials,
          context.region
        );

        const config = (criterion.validationConfig ||
          {}) as LambdaValidationConfig;
        const requiredName = config.functionName;
        const requiredRuntime = config.runtime;

        const matchingFunction = functions.find((f) =>
          requiredName ? f.name.includes(requiredName) : true
        );

        if (!matchingFunction) {
          return {
            passed: false,
            score: 0,
            maxScore: criterion.maxPoints,
            feedback: `✗ Lambda 関数が見つかりません${requiredName ? `: ${requiredName}` : ''}`,
          };
        }

        let score = criterion.maxPoints * 0.7;
        const checks: string[] = [`✓ 関数存在: ${matchingFunction.name}`];

        if (requiredRuntime && matchingFunction.runtime === requiredRuntime) {
          score += criterion.maxPoints * 0.3;
          checks.push(`✓ ランタイム: ${requiredRuntime}`);
        } else if (requiredRuntime) {
          checks.push(
            `✗ 期待ランタイム: ${requiredRuntime} (実際: ${matchingFunction.runtime})`
          );
        }

        return {
          passed: score >= criterion.maxPoints * 0.7,
          score: Math.round(score),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // CloudFormation スタック検証
    this.validators.set(
      'cloudformation-stack',
      async (criterion, credentials, _accountId, context) => {
        const config = (criterion.validationConfig ||
          {}) as CloudFormationValidationConfig;
        const stackName = config.stackName ?? `tenkacloud-${context.problemId}`;

        const stack = await this.describeStack(
          credentials,
          context.region,
          stackName
        );

        if (!stack) {
          return {
            passed: false,
            score: 0,
            maxScore: criterion.maxPoints,
            feedback: `✗ CloudFormation スタックが見つかりません: ${stackName}`,
          };
        }

        const isComplete =
          stack.status === 'CREATE_COMPLETE' ||
          stack.status === 'UPDATE_COMPLETE';

        return {
          passed: isComplete,
          score: isComplete
            ? criterion.maxPoints
            : Math.round(criterion.maxPoints * 0.5),
          maxScore: criterion.maxPoints,
          feedback: isComplete
            ? `✓ スタック正常: ${stackName}`
            : `✗ スタック状態異常: ${stack.status}`,
        };
      }
    );

    // VPC 設定検証
    this.validators.set(
      'vpc-config',
      async (criterion, credentials, _accountId, context) => {
        const vpcs = await this.describeVPCs(credentials, context.region);

        const config = (criterion.validationConfig ||
          {}) as VPCValidationConfig;
        const requiredSubnets = config.minSubnets ?? 2;

        let score = 0;
        const checks: string[] = [];

        if (vpcs.length > 0) {
          score += criterion.maxPoints * 0.4;
          checks.push(`✓ VPC 存在: ${vpcs.length} 個`);

          const totalSubnets = vpcs.reduce(
            (sum, vpc) => sum + vpc.subnetCount,
            0
          );
          if (totalSubnets >= requiredSubnets) {
            score += criterion.maxPoints * 0.3;
            checks.push(`✓ サブネット: ${totalSubnets} 個`);
          } else {
            checks.push(`✗ サブネット不足: ${totalSubnets}/${requiredSubnets}`);
          }

          const hasMultiAZ = vpcs.some((vpc) => vpc.azCount >= 2);
          if (hasMultiAZ) {
            score += criterion.maxPoints * 0.3;
            checks.push('✓ マルチ AZ');
          } else {
            checks.push('✗ マルチ AZ 未構成');
          }
        } else {
          checks.push('✗ VPC が見つかりません');
        }

        return {
          passed: score >= criterion.maxPoints * 0.7,
          score: Math.round(score),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // セキュリティグループ検証
    this.validators.set(
      'security-group',
      async (criterion, credentials, _accountId, context) => {
        const securityGroups = await this.describeSecurityGroups(
          credentials,
          context.region
        );

        const config = (criterion.validationConfig ||
          {}) as SecurityGroupValidationConfig;
        const prohibitedPorts = config.prohibitedPorts ?? [22, 3389]; // SSH, RDP
        const _requirePrivate = config.requirePrivate ?? true;

        let score = criterion.maxPoints;
        const checks: string[] = [];
        let hasViolation = false;

        for (const sg of securityGroups) {
          for (const rule of sg.inboundRules) {
            if (
              rule.source === '0.0.0.0/0' &&
              prohibitedPorts.includes(rule.port)
            ) {
              hasViolation = true;
              score -= criterion.maxPoints * 0.3;
              checks.push(
                `✗ ${sg.name}: ポート ${rule.port} がパブリックに開放`
              );
            }
          }
        }

        if (!hasViolation) {
          checks.push('✓ セキュリティグループ設定は適切です');
        }

        return {
          passed: !hasViolation,
          score: Math.max(0, Math.round(score)),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // IAM ポリシー検証
    this.validators.set(
      'iam-policy',
      async (criterion, credentials, _accountId, _context) => {
        const roles = await this.listIAMRoles(credentials);

        const config = (criterion.validationConfig ||
          {}) as IAMValidationConfig;
        const requiredRoleName = config.roleName;
        const _prohibitedActions = config.prohibitedActions ?? ['*'];

        let score = criterion.maxPoints;
        const checks: string[] = [];

        const targetRoles = requiredRoleName
          ? roles.filter((r) => r.name.includes(requiredRoleName))
          : roles;

        if (targetRoles.length === 0) {
          return {
            passed: false,
            score: 0,
            maxScore: criterion.maxPoints,
            feedback: `✗ IAM ロールが見つかりません${requiredRoleName ? `: ${requiredRoleName}` : ''}`,
          };
        }

        for (const role of targetRoles) {
          if (role.hasAdminAccess) {
            score -= criterion.maxPoints * 0.5;
            checks.push(`✗ ${role.name}: 管理者アクセスが付与されています`);
          }
        }

        if (score === criterion.maxPoints) {
          checks.push('✓ IAM ポリシーは最小権限の原則に従っています');
        }

        return {
          passed: score >= criterion.maxPoints * 0.5,
          score: Math.max(0, Math.round(score)),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // CloudWatch アラーム検証
    this.validators.set(
      'cloudwatch-alarm',
      async (criterion, credentials, _accountId, context) => {
        const alarms = await this.listCloudWatchAlarms(
          credentials,
          context.region
        );

        const config = (criterion.validationConfig ||
          {}) as CloudWatchValidationConfig;
        const requiredAlarmCount = config.minAlarms ?? 1;
        const requiredMetrics = config.metrics ?? [];

        let score = 0;
        const checks: string[] = [];

        if (alarms.length >= requiredAlarmCount) {
          score += criterion.maxPoints * 0.5;
          checks.push(`✓ アラーム数: ${alarms.length}`);
        } else {
          checks.push(`✗ アラーム不足: ${alarms.length}/${requiredAlarmCount}`);
        }

        if (requiredMetrics.length > 0) {
          const configuredMetrics = alarms.map((a) => a.metric);
          const missingMetrics = requiredMetrics.filter(
            (m: string) => !configuredMetrics.includes(m)
          );

          if (missingMetrics.length === 0) {
            score += criterion.maxPoints * 0.5;
            checks.push('✓ 必要なメトリクスアラーム設定済み');
          } else {
            checks.push(`✗ 未設定メトリクス: ${missingMetrics.join(', ')}`);
          }
        } else {
          score += criterion.maxPoints * 0.5;
        }

        return {
          passed: score >= criterion.maxPoints * 0.5,
          score: Math.round(score),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // API Gateway 検証
    this.validators.set(
      'api-gateway',
      async (criterion, credentials, _accountId, context) => {
        const apis = await this.listAPIGateways(credentials, context.region);

        const config = (criterion.validationConfig ||
          {}) as APIGatewayValidationConfig;
        const requiredName = config.apiName;

        const matchingAPI = apis.find((api) =>
          requiredName ? api.name.includes(requiredName) : true
        );

        if (!matchingAPI) {
          return {
            passed: false,
            score: 0,
            maxScore: criterion.maxPoints,
            feedback: `✗ API Gateway が見つかりません${requiredName ? `: ${requiredName}` : ''}`,
          };
        }

        let score = criterion.maxPoints * 0.6;
        const checks: string[] = [`✓ API Gateway 存在: ${matchingAPI.name}`];

        if (matchingAPI.deployed) {
          score += criterion.maxPoints * 0.4;
          checks.push('✓ デプロイ済み');
        } else {
          checks.push('✗ 未デプロイ');
        }

        return {
          passed: score >= criterion.maxPoints * 0.6,
          score: Math.round(score),
          maxScore: criterion.maxPoints,
          feedback: checks.join(', '),
        };
      }
    );

    // 汎用検証（フォールバック）
    this.validators.set(
      'generic',
      async (criterion, _credentials, _accountId, _context) => {
        // 汎用検証 - 常に部分点を付与
        return {
          passed: true,
          score: Math.round(criterion.maxPoints * 0.5),
          maxScore: criterion.maxPoints,
          feedback: `⚠ 自動検証未対応: ${criterion.name} (手動確認が必要)`,
        };
      }
    );
  }

  /**
   * カスタム検証関数を登録
   */
  registerValidator(type: string, validator: ResourceValidator): void {
    this.validators.set(type, validator);
  }

  // ==========================================================================
  // AWS API シミュレーション（実際の実装では AWS SDK を使用）
  // ==========================================================================

  private async getStackOutputs(
    stackName: string,
    _credentials: CloudCredentials
  ): Promise<Record<string, string>> {
    console.log(`[AWSGameDay] Getting stack outputs for ${stackName}`);
    return {};
  }

  private async describeEC2Instances(
    _credentials: CloudCredentials,
    _region: string,
    _accountId: string
  ): Promise<{ instanceId: string; state: string; instanceType: string }[]> {
    // 実際の実装では ec2.describeInstances を使用
    console.log('[AWSGameDay] Describing EC2 instances');
    return [
      { instanceId: 'i-mock1', state: 'running', instanceType: 't3.micro' },
    ];
  }

  private async listS3Buckets(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<{ name: string; versioning: boolean; encryption: boolean }[]> {
    console.log('[AWSGameDay] Listing S3 buckets');
    return [{ name: 'mock-bucket', versioning: true, encryption: true }];
  }

  private async listLambdaFunctions(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<{ name: string; runtime: string }[]> {
    console.log('[AWSGameDay] Listing Lambda functions');
    return [{ name: 'mock-function', runtime: 'nodejs20.x' }];
  }

  private async describeStack(
    _credentials: CloudCredentials,
    _region: string,
    stackName: string
  ): Promise<{ name: string; status: string } | null> {
    console.log(`[AWSGameDay] Describing stack ${stackName}`);
    return { name: stackName, status: 'CREATE_COMPLETE' };
  }

  private async describeVPCs(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<{ vpcId: string; subnetCount: number; azCount: number }[]> {
    console.log('[AWSGameDay] Describing VPCs');
    return [{ vpcId: 'vpc-mock', subnetCount: 4, azCount: 2 }];
  }

  private async describeSecurityGroups(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<
    { name: string; inboundRules: { port: number; source: string }[] }[]
  > {
    console.log('[AWSGameDay] Describing Security Groups');
    return [
      { name: 'mock-sg', inboundRules: [{ port: 443, source: '0.0.0.0/0' }] },
    ];
  }

  private async listIAMRoles(
    _credentials: CloudCredentials
  ): Promise<{ name: string; hasAdminAccess: boolean }[]> {
    console.log('[AWSGameDay] Listing IAM roles');
    return [{ name: 'mock-role', hasAdminAccess: false }];
  }

  private async listCloudWatchAlarms(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<{ name: string; metric: string }[]> {
    console.log('[AWSGameDay] Listing CloudWatch alarms');
    return [{ name: 'mock-alarm', metric: 'CPUUtilization' }];
  }

  private async listAPIGateways(
    _credentials: CloudCredentials,
    _region: string
  ): Promise<{ name: string; deployed: boolean }[]> {
    console.log('[AWSGameDay] Listing API Gateways');
    return [{ name: 'mock-api', deployed: true }];
  }
}

/**
 * AWS GameDay 採点プロバイダーのインスタンスを取得
 */
export function createAWSGameDayScoringProvider(): AWSGameDayScoringProvider {
  return new AWSGameDayScoringProvider();
}
