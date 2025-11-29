/**
 * Local Cloud Provider Implementation
 *
 * ローカル開発環境用のプロバイダー実装（Docker Compose ベース）
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
 * ローカル環境の擬似リージョン
 */
const LOCAL_REGIONS: RegionInfo[] = [
  { code: 'local', name: 'Local Development', available: true },
  { code: 'docker', name: 'Docker Compose', available: true },
];

/**
 * LocalCloudProvider
 *
 * Docker Compose を使用したローカル開発環境用プロバイダー
 */
export class LocalCloudProvider implements ICloudProvider {
  readonly provider: CloudProvider = 'local';
  readonly displayName = 'Local Development';

  private deployedStacks: Map<string, LocalStack> = new Map();

  /**
   * 認証情報の検証（ローカルでは常に成功）
   */
  async validateCredentials(credentials: CloudCredentials): Promise<boolean> {
    return credentials.provider === 'local';
  }

  /**
   * 問題スタックのデプロイ（Docker Compose）
   */
  async deployStack(
    problem: Problem,
    credentials: CloudCredentials,
    options: DeployStackOptions
  ): Promise<DeploymentResult> {
    const startedAt = new Date();

    try {
      // ローカルテンプレートの取得
      const template = problem.deployment.templates.local;
      if (!template) {
        // AWS テンプレートをフォールバックとして使用
        const awsTemplate = problem.deployment.templates.aws;
        if (awsTemplate) {
          console.log(
            `[Local] Using AWS template as fallback for problem ${problem.id}`
          );
        }
      }

      if (options.dryRun) {
        return {
          success: true,
          stackName: options.stackName,
          startedAt,
          completedAt: new Date(),
        };
      }

      // Docker Compose でサービスを起動
      const stackId = `local-${options.stackName}-${Date.now()}`;
      const composeFile = await this.generateDockerCompose(problem, options);

      // Docker Compose up を実行
      await this.runDockerCompose('up', composeFile, options.stackName);

      // スタック情報を保存
      const stack: LocalStack = {
        stackId,
        stackName: options.stackName,
        problemId: problem.id,
        status: 'CREATE_COMPLETE',
        outputs: {
          ServiceUrl: `http://localhost:${this.getAvailablePort()}`,
          DashboardUrl: `http://localhost:${this.getAvailablePort() + 1}`,
        },
        createdAt: new Date(),
        composeFile,
      };
      this.deployedStacks.set(options.stackName, stack);

      return {
        success: true,
        stackId,
        stackName: options.stackName,
        outputs: stack.outputs,
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
    _credentials: CloudCredentials
  ): Promise<StackStatus | null> {
    const stack = this.deployedStacks.get(stackName);
    if (!stack) {
      return null;
    }

    return {
      stackName: stack.stackName,
      stackId: stack.stackId,
      status: stack.status,
      outputs: stack.outputs,
      lastUpdatedTime: stack.createdAt,
    };
  }

  /**
   * スタックの削除
   */
  async deleteStack(
    stackName: string,
    _credentials: CloudCredentials
  ): Promise<DeploymentResult> {
    const startedAt = new Date();

    try {
      const stack = this.deployedStacks.get(stackName);
      if (!stack) {
        return {
          success: false,
          stackName,
          error: `Stack ${stackName} not found`,
          startedAt,
          completedAt: new Date(),
        };
      }

      // Docker Compose down を実行
      await this.runDockerCompose('down', stack.composeFile, stackName);

      // スタック情報を削除
      this.deployedStacks.delete(stackName);

      return {
        success: true,
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
    _credentials: CloudCredentials
  ): Promise<Record<string, string>> {
    const stack = this.deployedStacks.get(stackName);
    return stack?.outputs || {};
  }

  /**
   * 静的ファイルのアップロード（ローカルではファイルコピー）
   */
  async uploadStaticFiles(
    localPath: string,
    _remotePath: string,
    _credentials: CloudCredentials
  ): Promise<string> {
    // ローカル環境ではファイルをそのまま使用
    console.log(`[Local] Static files available at: ${localPath}`);
    return `file://${localPath}`;
  }

  /**
   * リソースのクリーンアップ
   */
  async cleanupResources(
    _accountId: string,
    credentials: CloudCredentials,
    options?: CleanupOptions
  ): Promise<CleanupResult> {
    const deletedResources: CleanupResult['deletedResources'] = [];
    const failedResources: CleanupResult['failedResources'] = [];

    for (const [stackName, stack] of this.deployedStacks) {
      try {
        if (!options?.dryRun) {
          await this.deleteStack(stackName, credentials);
        }
        deletedResources.push({
          type: 'Docker::Compose',
          id: stack.stackId,
          name: stackName,
          region: 'local',
        });
      } catch (error) {
        failedResources.push({
          type: 'Docker::Compose',
          id: stack.stackId,
          name: stackName,
          region: 'local',
          error: error instanceof Error ? error.message : String(error),
        });
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
  }

  /**
   * 利用可能なリージョン一覧の取得
   */
  async getAvailableRegions(): Promise<RegionInfo[]> {
    return LOCAL_REGIONS;
  }

  /**
   * アカウント情報の取得
   */
  async getAccountInfo(credentials: CloudCredentials): Promise<AccountInfo> {
    return {
      accountId: credentials.accountId || 'local-dev',
      accountName: 'Local Development',
      provider: 'local',
    };
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private async generateDockerCompose(
    problem: Problem,
    options: DeployStackOptions
  ): Promise<string> {
    // 問題に基づいて Docker Compose ファイルを生成
    const compose = {
      version: '3.8',
      services: {
        [`${options.stackName}-app`]: {
          image: `tenkacloud/problem-${problem.id}:latest`,
          ports: [`${this.getAvailablePort()}:8080`],
          environment: {
            PROBLEM_ID: problem.id,
            STACK_NAME: options.stackName,
            ...options.parameters,
          },
          labels: {
            'tenkacloud.problem-id': problem.id,
            'tenkacloud.stack-name': options.stackName,
            'tenkacloud.managed-by': 'tenkacloud',
          },
        },
      },
      networks: {
        default: {
          name: `tenkacloud-${options.stackName}`,
        },
      },
    };

    return JSON.stringify(compose, null, 2);
  }

  private async runDockerCompose(
    command: 'up' | 'down',
    composeContent: string,
    projectName: string
  ): Promise<void> {
    // 実際の実装では Docker Compose CLI を実行
    console.log(`[Local] Docker Compose ${command} for project ${projectName}`);
    console.log(`[Local] Compose content:`, composeContent);

    // シミュレーション: 少し待機
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private getAvailablePort(): number {
    // 利用可能なポートを取得（実際の実装ではポートスキャンを行う）
    return 8080 + this.deployedStacks.size;
  }
}

/**
 * ローカルスタック情報
 */
interface LocalStack {
  stackId: string;
  stackName: string;
  problemId: string;
  status: StackStatus['status'];
  outputs: Record<string, string>;
  createdAt: Date;
  composeFile: string;
}

/**
 * ローカルプロバイダーのシングルトンインスタンスを取得
 */
export function getLocalProvider(): LocalCloudProvider {
  return new LocalCloudProvider();
}
