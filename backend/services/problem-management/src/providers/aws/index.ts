/**
 * AWS Cloud Provider Implementation
 *
 * AWS CloudFormation/SAM を使用したスタックデプロイ実装
 */

import type {
  CloudCredentials,
  CloudProvider,
  DeploymentResult,
  Problem,
  StackStatus,
} from '../../types';
import type {
  AccountInfo,
  CleanupOptions,
  CleanupResult,
  DeployStackOptions,
  ICloudProvider,
  RegionInfo,
} from '../interface';

/**
 * AWS リージョン一覧
 */
const AWS_REGIONS: RegionInfo[] = [
  { code: 'us-east-1', name: 'US East (N. Virginia)', available: true },
  { code: 'us-east-2', name: 'US East (Ohio)', available: true },
  { code: 'us-west-1', name: 'US West (N. California)', available: true },
  { code: 'us-west-2', name: 'US West (Oregon)', available: true },
  { code: 'ap-south-1', name: 'Asia Pacific (Mumbai)', available: true },
  { code: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)', available: true },
  { code: 'ap-northeast-2', name: 'Asia Pacific (Seoul)', available: true },
  { code: 'ap-northeast-3', name: 'Asia Pacific (Osaka)', available: true },
  { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)', available: true },
  { code: 'ap-southeast-2', name: 'Asia Pacific (Sydney)', available: true },
  { code: 'ca-central-1', name: 'Canada (Central)', available: true },
  { code: 'eu-central-1', name: 'Europe (Frankfurt)', available: true },
  { code: 'eu-west-1', name: 'Europe (Ireland)', available: true },
  { code: 'eu-west-2', name: 'Europe (London)', available: true },
  { code: 'eu-west-3', name: 'Europe (Paris)', available: true },
  { code: 'eu-north-1', name: 'Europe (Stockholm)', available: true },
  { code: 'sa-east-1', name: 'South America (São Paulo)', available: true },
];

/**
 * AWSCloudProvider
 *
 * AWS CloudFormation を使用したスタックデプロイを実装
 */
export class AWSCloudProvider implements ICloudProvider {
  readonly provider: CloudProvider = 'aws';
  readonly displayName = 'Amazon Web Services';

  /**
   * 認証情報の検証
   */
  async validateCredentials(credentials: CloudCredentials): Promise<boolean> {
    if (credentials.provider !== 'aws') {
      return false;
    }

    // AssumeRole または直接認証情報のいずれかが必要
    if (
      !credentials.roleArn &&
      (!credentials.accessKeyId || !credentials.secretAccessKey)
    ) {
      return false;
    }

    try {
      // STS GetCallerIdentity で認証を検証
      const stsResponse = await this.callSTS(credentials, 'GetCallerIdentity');
      return !!stsResponse.Account;
    } catch {
      return false;
    }
  }

  /**
   * 問題スタックのデプロイ
   */
  async deployStack(
    problem: Problem,
    credentials: CloudCredentials,
    options: DeployStackOptions
  ): Promise<DeploymentResult> {
    const startedAt = new Date();

    try {
      // テンプレートの取得
      const template = problem.deployment.templates.aws;
      if (!template) {
        throw new Error('AWS deployment template not found for this problem');
      }

      // パラメータの構築
      const parameters = this.buildParameters(options.parameters || {});

      // タグの構築
      const tags = this.buildTags({
        ...options.tags,
        'tenkacloud:problem-id': problem.id,
        'tenkacloud:problem-type': problem.type,
        'tenkacloud:managed-by': 'tenkacloud',
      });

      // CloudFormation CreateStack を呼び出し
      const createStackParams = {
        StackName: options.stackName,
        TemplateBody: await this.loadTemplate(template.path),
        Parameters: parameters,
        Tags: tags,
        Capabilities: [
          'CAPABILITY_IAM',
          'CAPABILITY_NAMED_IAM',
          'CAPABILITY_AUTO_EXPAND',
        ],
        TimeoutInMinutes: Math.ceil((options.timeoutSeconds || 3600) / 60),
        OnFailure:
          options.rollbackOnFailure !== false ? 'ROLLBACK' : 'DO_NOTHING',
      };

      if (options.dryRun) {
        // ドライランの場合はテンプレート検証のみ
        await this.validateTemplate(
          createStackParams.TemplateBody,
          credentials
        );
        return {
          success: true,
          stackName: options.stackName,
          startedAt,
          completedAt: new Date(),
        };
      }

      const createResult = await this.callCloudFormation(
        credentials,
        options.region,
        'CreateStack',
        createStackParams
      );

      // スタック作成完了を待機
      const finalStatus = await this.waitForStackComplete(
        options.stackName,
        credentials,
        options.region,
        options.timeoutSeconds || 3600
      );

      if (finalStatus.status === 'CREATE_COMPLETE') {
        return {
          success: true,
          stackId: createResult.StackId as string | undefined,
          stackName: options.stackName,
          outputs: finalStatus.outputs,
          startedAt,
          completedAt: new Date(),
        };
      }

      return {
        success: false,
        stackId: createResult.StackId as string | undefined,
        stackName: options.stackName,
        error:
          finalStatus.statusReason ||
          `Stack creation failed with status: ${finalStatus.status}`,
        startedAt,
        completedAt: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        stackName: options.stackName,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date(),
      };
    }
  }

  /**
   * スタックのステータス取得
   */
  async getStackStatus(
    stackName: string,
    credentials: CloudCredentials
  ): Promise<StackStatus | null> {
    try {
      const result = await this.callCloudFormation(
        credentials,
        credentials.region,
        'DescribeStacks',
        { StackName: stackName }
      );

      const stacks = result.Stacks as
        | Array<Record<string, unknown>>
        | undefined;
      if (!stacks || stacks.length === 0) {
        return null;
      }

      const stack = stacks[0];
      return {
        stackName: stack.StackName as string,
        stackId: stack.StackId as string,
        status: stack.StackStatus as StackStatus['status'],
        statusReason: stack.StackStatusReason as string | undefined,
        outputs: this.parseOutputs(
          (stack.Outputs || []) as Array<{
            OutputKey: string;
            OutputValue: string;
          }>
        ),
        lastUpdatedTime: stack.LastUpdatedTime
          ? new Date(stack.LastUpdatedTime as string)
          : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * スタックの削除
   */
  async deleteStack(
    stackName: string,
    credentials: CloudCredentials
  ): Promise<DeploymentResult> {
    const startedAt = new Date();

    try {
      await this.callCloudFormation(
        credentials,
        credentials.region,
        'DeleteStack',
        { StackName: stackName }
      );

      // 削除完了を待機
      const finalStatus = await this.waitForStackDeleted(
        stackName,
        credentials,
        credentials.region,
        1800 // 30分
      );

      return {
        success: finalStatus === 'DELETE_COMPLETE',
        stackName,
        startedAt,
        completedAt: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        stackName,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date(),
      };
    }
  }

  /**
   * スタック出力の取得
   */
  async getStackOutputs(
    stackName: string,
    credentials: CloudCredentials
  ): Promise<Record<string, string>> {
    const status = await this.getStackStatus(stackName, credentials);
    return status?.outputs || {};
  }

  /**
   * 静的ファイルのアップロード
   */
  async uploadStaticFiles(
    localPath: string,
    remotePath: string,
    credentials: CloudCredentials
  ): Promise<string> {
    // S3 にアップロード
    const bucketName = this.extractBucketName(remotePath);
    const key = this.extractS3Key(remotePath);

    await this.callS3(credentials, credentials.region, 'PutObject', {
      Bucket: bucketName,
      Key: key,
      Body: await this.readFile(localPath),
    });

    return `s3://${bucketName}/${key}`;
  }

  /**
   * リソースのクリーンアップ
   */
  async cleanupResources(
    accountId: string,
    credentials: CloudCredentials,
    options?: CleanupOptions
  ): Promise<CleanupResult> {
    // AWS-Nuke 風のリソースクリーンアップ
    // 実際の実装では aws-nuke または独自のクリーンアップロジックを使用

    const deletedResources: CleanupResult['deletedResources'] = [];
    const failedResources: CleanupResult['failedResources'] = [];

    // TenkaCloud が管理するリソースのみを削除
    const tagFilter = {
      'tenkacloud:managed-by': 'tenkacloud',
    };

    try {
      // CloudFormation スタックの削除
      const stacks = await this.listManagedStacks(credentials, tagFilter);

      for (const stack of stacks) {
        if (this.shouldDeleteResource(stack.StackName, options)) {
          try {
            if (!options?.dryRun) {
              await this.deleteStack(stack.StackName, credentials);
            }
            deletedResources.push({
              type: 'CloudFormation::Stack',
              id: stack.StackId,
              name: stack.StackName,
              region: credentials.region,
            });
          } catch (error) {
            failedResources.push({
              type: 'CloudFormation::Stack',
              id: stack.StackId,
              name: stack.StackName,
              region: credentials.region,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return {
        success: failedResources.length === 0,
        deletedResources,
        failedResources,
        totalDeleted: deletedResources.length,
        totalFailed: failedResources.length,
        dryRun: options?.dryRun ?? false,
      };
    } catch (error) {
      return {
        success: false,
        deletedResources,
        failedResources: [
          {
            type: 'Cleanup',
            id: accountId,
            error: error instanceof Error ? error.message : String(error),
          },
        ],
        totalDeleted: deletedResources.length,
        totalFailed: 1,
        dryRun: options?.dryRun ?? false,
      };
    }
  }

  /**
   * 利用可能なリージョン一覧の取得
   */
  async getAvailableRegions(): Promise<RegionInfo[]> {
    return AWS_REGIONS;
  }

  /**
   * アカウント情報の取得
   */
  async getAccountInfo(credentials: CloudCredentials): Promise<AccountInfo> {
    const stsResponse = await this.callSTS(credentials, 'GetCallerIdentity');

    // IAM エイリアスの取得を試みる
    let alias: string | undefined;
    try {
      const iamResponse = await this.callIAM(credentials, 'ListAccountAliases');
      const aliases = iamResponse.AccountAliases as string[] | undefined;
      alias = aliases?.[0];
    } catch {
      // エイリアスが取得できない場合は無視
    }

    return {
      accountId: stsResponse.Account as string,
      alias,
      provider: 'aws',
    };
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private async callSTS(
    credentials: CloudCredentials,
    action: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // 実際の実装では AWS SDK を使用
    // ここではモック実装
    console.log(`[AWS STS] ${action}`, params);
    return {
      Account: credentials.accountId,
      Arn: `arn:aws:iam::${credentials.accountId}:root`,
    };
  }

  private async callCloudFormation(
    credentials: CloudCredentials,
    region: string,
    action: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // 実際の実装では AWS SDK を使用
    console.log(`[AWS CloudFormation] ${action} in ${region}`, params);
    return {
      StackId: `arn:aws:cloudformation:${region}:${credentials.accountId}:stack/${params.StackName}/xxx`,
    };
  }

  private async callS3(
    credentials: CloudCredentials,
    region: string,
    action: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    console.log(`[AWS S3] ${action} in ${region}`, params);
    return {};
  }

  private async callIAM(
    credentials: CloudCredentials,
    action: string
  ): Promise<Record<string, unknown>> {
    console.log(`[AWS IAM] ${action}`);
    return { AccountAliases: [] };
  }

  private buildParameters(
    params: Record<string, string>
  ): { ParameterKey: string; ParameterValue: string }[] {
    return Object.entries(params).map(([key, value]) => ({
      ParameterKey: key,
      ParameterValue: value,
    }));
  }

  private buildTags(
    tags: Record<string, string>
  ): { Key: string; Value: string }[] {
    return Object.entries(tags).map(([key, value]) => ({
      Key: key,
      Value: value,
    }));
  }

  private async loadTemplate(path: string): Promise<string> {
    // 実際の実装ではファイルシステムまたは S3 からテンプレートを読み込む
    console.log(`[AWS] Loading template from ${path}`);
    return '{}';
  }

  private async validateTemplate(
    templateBody: string,
    credentials: CloudCredentials
  ): Promise<void> {
    await this.callCloudFormation(
      credentials,
      credentials.region,
      'ValidateTemplate',
      {
        TemplateBody: templateBody,
      }
    );
  }

  private async waitForStackComplete(
    stackName: string,
    credentials: CloudCredentials,
    region: string,
    timeoutSeconds: number
  ): Promise<StackStatus> {
    const startTime = Date.now();
    const pollInterval = 10000; // 10秒

    while (Date.now() - startTime < timeoutSeconds * 1000) {
      const status = await this.getStackStatus(stackName, {
        ...credentials,
        region,
      });
      if (!status) {
        throw new Error(`Stack ${stackName} not found`);
      }

      if (
        status.status.endsWith('_COMPLETE') ||
        status.status.endsWith('_FAILED')
      ) {
        return status;
      }

      await this.sleep(pollInterval);
    }

    throw new Error(`Timeout waiting for stack ${stackName}`);
  }

  private async waitForStackDeleted(
    stackName: string,
    credentials: CloudCredentials,
    region: string,
    timeoutSeconds: number
  ): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 10000;

    while (Date.now() - startTime < timeoutSeconds * 1000) {
      const status = await this.getStackStatus(stackName, {
        ...credentials,
        region,
      });
      if (!status) {
        return 'DELETE_COMPLETE';
      }

      if (status.status === 'DELETE_FAILED') {
        throw new Error(`Stack deletion failed: ${status.statusReason}`);
      }

      await this.sleep(pollInterval);
    }

    throw new Error(`Timeout waiting for stack deletion: ${stackName}`);
  }

  private parseOutputs(
    outputs: { OutputKey: string; OutputValue: string }[]
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const output of outputs) {
      result[output.OutputKey] = output.OutputValue;
    }
    return result;
  }

  private extractBucketName(s3Path: string): string {
    const match = s3Path.match(/s3:\/\/([^/]+)/);
    return match?.[1] || '';
  }

  private extractS3Key(s3Path: string): string {
    const match = s3Path.match(/s3:\/\/[^/]+\/(.+)/);
    return match?.[1] || '';
  }

  private async readFile(path: string): Promise<Buffer> {
    // 実際の実装ではファイルを読み込む
    console.log(`[AWS] Reading file from ${path}`);
    return Buffer.from('');
  }

  private async listManagedStacks(
    credentials: CloudCredentials,
    tagFilter: Record<string, string>
  ): Promise<{ StackName: string; StackId: string }[]> {
    // 実際の実装ではタグでフィルタリングしたスタック一覧を返す
    console.log(`[AWS] Listing managed stacks with tags:`, tagFilter);
    return [];
  }

  private shouldDeleteResource(
    resourceName: string,
    options?: CleanupOptions
  ): boolean {
    if (!options) return true;

    // 除外パターンのチェック
    if (options.excludePatterns) {
      for (const pattern of options.excludePatterns) {
        if (new RegExp(pattern).test(resourceName)) {
          return false;
        }
      }
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * AWS プロバイダーのシングルトンインスタンスを取得
 */
export function getAWSProvider(): AWSCloudProvider {
  return new AWSCloudProvider();
}
