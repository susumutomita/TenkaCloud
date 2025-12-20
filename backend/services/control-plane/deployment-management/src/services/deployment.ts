import type { DeploymentStatus } from '@tenkacloud/dynamodb';
import { deploymentRepository } from '../lib/dynamodb';
import { createK8sClient, type K8sClient } from '../lib/kubernetes-factory';
import { createLogger } from '../lib/logger';

const logger = createLogger('deployment-service');

interface CreateDeploymentInput {
  tenantId: string;
  tenantSlug: string;
  serviceName: string;
  image: string;
  version: string;
  replicas?: number;
}

interface UpdateDeploymentInput {
  image: string;
  version: string;
  replicas?: number;
}

interface ListDeploymentsInput {
  tenantId?: string;
  tenantSlug?: string;
  status?: DeploymentStatus;
  limit?: number;
  offset?: number;
}

export class DeploymentService {
  private k8sClient: K8sClient;

  constructor(k8sClient?: K8sClient) {
    this.k8sClient = k8sClient ?? createK8sClient();
  }

  async createDeployment(input: CreateDeploymentInput) {
    const {
      tenantId,
      tenantSlug,
      serviceName,
      image,
      version,
      replicas = 1,
    } = input;

    const namespace = `tenant-${tenantSlug}`;

    // DBにデプロイメント記録を作成
    const deployment = await deploymentRepository.create({
      tenantId,
      tenantSlug,
      namespace,
      serviceName,
      image,
      version,
      replicas,
      type: 'CREATE',
    });

    // 履歴を記録
    await this.addHistory(
      deployment.id,
      'PENDING',
      'デプロイメントを作成しました'
    );

    try {
      // ステータスを更新
      await this.updateStatus(deployment.id, 'IN_PROGRESS');

      // Namespaceを作成
      await this.k8sClient.createNamespace(tenantSlug);

      // Deploymentを作成
      await this.k8sClient.createDeployment(
        namespace,
        serviceName,
        image,
        replicas
      );

      // Serviceを作成
      await this.k8sClient.createService(namespace, serviceName, 80);

      // 完了ステータスに更新
      await this.updateStatus(deployment.id, 'SUCCEEDED');
      await deploymentRepository.update(deployment.id, {
        completedAt: new Date(),
      });

      logger.info(
        { deploymentId: deployment.id, tenantSlug, serviceName },
        'デプロイメントが完了しました'
      );
    } catch (error) {
      await this.updateStatus(
        deployment.id,
        'FAILED',
        error instanceof Error ? error.message : '不明なエラー'
      );
      logger.error(
        { error, deploymentId: deployment.id },
        'デプロイメントに失敗しました'
      );
      throw error;
    }

    return deploymentRepository.findById(deployment.id);
  }

  async updateDeployment(deploymentId: string, input: UpdateDeploymentInput) {
    const existing = await deploymentRepository.findById(deploymentId);

    if (!existing) {
      return null;
    }

    const { image, version, replicas = existing.replicas } = input;

    // 新しいデプロイメント記録を作成（ローリングアップデート用）
    const deployment = await deploymentRepository.create({
      tenantId: existing.tenantId,
      tenantSlug: existing.tenantSlug,
      namespace: existing.namespace,
      serviceName: existing.serviceName,
      image,
      version,
      replicas,
      type: 'UPDATE',
    });

    await this.addHistory(
      deployment.id,
      'PENDING',
      'ローリングアップデートを開始します'
    );

    try {
      await this.updateStatus(deployment.id, 'IN_PROGRESS');

      // Deploymentを更新（ローリングアップデート）
      await this.k8sClient.updateDeployment(
        existing.namespace,
        existing.serviceName,
        image,
        replicas
      );

      await this.updateStatus(deployment.id, 'SUCCEEDED');
      await deploymentRepository.update(deployment.id, {
        completedAt: new Date(),
      });

      logger.info(
        { deploymentId: deployment.id, image, version },
        'ローリングアップデートが完了しました'
      );
    } catch (error) {
      await this.updateStatus(
        deployment.id,
        'FAILED',
        error instanceof Error ? error.message : '不明なエラー'
      );
      throw error;
    }

    return deploymentRepository.findById(deployment.id);
  }

  async rollbackDeployment(deploymentId: string) {
    const existing = await deploymentRepository.findById(deploymentId);

    if (!existing) {
      return null;
    }

    if (!existing.previousImage) {
      throw new Error('ロールバック先のイメージがありません');
    }

    // ロールバック用のデプロイメント記録を作成
    const deployment = await deploymentRepository.create({
      tenantId: existing.tenantId,
      tenantSlug: existing.tenantSlug,
      namespace: existing.namespace,
      serviceName: existing.serviceName,
      image: existing.previousImage,
      version: `rollback-from-${existing.version}`,
      replicas: existing.replicas,
      type: 'ROLLBACK',
    });

    await this.addHistory(deployment.id, 'PENDING', 'ロールバックを開始します');

    try {
      await this.updateStatus(deployment.id, 'IN_PROGRESS');

      await this.k8sClient.updateDeployment(
        existing.namespace,
        existing.serviceName,
        existing.previousImage,
        existing.replicas
      );

      await this.updateStatus(deployment.id, 'SUCCEEDED');
      await deploymentRepository.update(deployment.id, {
        completedAt: new Date(),
      });

      // 元のデプロイメントをロールバック済みに更新
      await deploymentRepository.update(deploymentId, {
        status: 'ROLLED_BACK',
      });

      logger.info(
        { deploymentId: deployment.id, originalId: deploymentId },
        'ロールバックが完了しました'
      );
    } catch (error) {
      await this.updateStatus(
        deployment.id,
        'FAILED',
        error instanceof Error ? error.message : '不明なエラー'
      );
      throw error;
    }

    return deploymentRepository.findById(deployment.id);
  }

  async getDeploymentStatus(deploymentId: string) {
    const deployment = await deploymentRepository.findById(deploymentId);

    if (!deployment) {
      return null;
    }

    // Kubernetes のステータスも取得
    const k8sStatus = await this.k8sClient.getDeploymentStatus(
      deployment.namespace,
      deployment.serviceName
    );

    return {
      deployment,
      kubernetes: k8sStatus,
    };
  }

  async getDeploymentById(id: string) {
    return deploymentRepository.findById(id);
  }

  async listDeployments(input: ListDeploymentsInput) {
    const { tenantId, status, limit = 20 } = input;

    if (!tenantId) {
      return { deployments: [], total: 0 };
    }

    const [result, total] = await Promise.all([
      deploymentRepository.listByTenant(tenantId, {
        status,
        limit,
      }),
      deploymentRepository.countByTenant(tenantId, status),
    ]);

    return { deployments: result.deployments, total };
  }

  async getDeploymentHistory(deploymentId: string) {
    return deploymentRepository.getHistory(deploymentId);
  }

  private async updateStatus(
    deploymentId: string,
    status: DeploymentStatus,
    errorMessage?: string
  ) {
    const updateData: {
      status: DeploymentStatus;
      errorMessage?: string;
      startedAt?: Date;
    } = { status };

    if (status === 'IN_PROGRESS') {
      updateData.startedAt = new Date();
    }

    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }

    await deploymentRepository.update(deploymentId, updateData);

    await this.addHistory(deploymentId, status, errorMessage);
  }

  private async addHistory(
    deploymentId: string,
    status: DeploymentStatus,
    message?: string
  ) {
    await deploymentRepository.addHistory({
      deploymentId,
      status,
      message,
    });
  }
}
