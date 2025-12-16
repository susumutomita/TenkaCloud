import { createLogger } from './logger';

const logger = createLogger('k8s-mock-client');

/**
 * ローカル開発用のモック Kubernetes クライアント
 * 実際の K8s クラスタなしで開発・テストできるようにする
 */
export class MockKubernetesClient {
  private namespaces = new Map<string, boolean>();
  private deployments = new Map<
    string,
    { image: string; replicas: number; status: string }
  >();
  private services = new Map<string, boolean>();

  async createNamespace(tenantSlug: string): Promise<string> {
    const namespaceName = `tenant-${tenantSlug}`;
    this.namespaces.set(namespaceName, true);
    logger.info(
      { namespace: namespaceName },
      '[MOCK] Namespace を作成しました'
    );
    return namespaceName;
  }

  async createDeployment(
    namespace: string,
    serviceName: string,
    image: string,
    replicas: number
  ): Promise<void> {
    const key = `${namespace}/${serviceName}`;
    this.deployments.set(key, { image, replicas, status: 'Running' });
    logger.info(
      { serviceName, namespace, image, replicas },
      '[MOCK] Deployment を作成しました'
    );
  }

  async updateDeployment(
    namespace: string,
    serviceName: string,
    image: string,
    replicas: number
  ): Promise<void> {
    const key = `${namespace}/${serviceName}`;
    this.deployments.set(key, { image, replicas, status: 'Updating' });
    // シミュレート: 更新完了
    setTimeout(() => {
      const deployment = this.deployments.get(key);
      if (deployment) {
        deployment.status = 'Running';
      }
    }, 1000);
    logger.info(
      { serviceName, namespace, image, replicas },
      '[MOCK] Deployment を更新しました'
    );
  }

  async getDeploymentStatus(
    namespace: string,
    serviceName: string
  ): Promise<{
    availableReplicas: number;
    readyReplicas: number;
    replicas: number;
    updatedReplicas: number;
  } | null> {
    const key = `${namespace}/${serviceName}`;
    const deployment = this.deployments.get(key);

    if (!deployment) {
      return null;
    }

    return {
      availableReplicas: deployment.replicas,
      readyReplicas: deployment.replicas,
      replicas: deployment.replicas,
      updatedReplicas: deployment.replicas,
    };
  }

  async createService(
    namespace: string,
    serviceName: string,
    port: number
  ): Promise<void> {
    const key = `${namespace}/${serviceName}`;
    this.services.set(key, true);
    logger.info(
      { serviceName, namespace, port },
      '[MOCK] Service を作成しました'
    );
  }
}
