import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  V1Namespace,
  V1Deployment,
  V1Service,
} from '@kubernetes/client-node';
import { createLogger } from './logger';

const logger = createLogger('k8s-client');

export class KubernetesClient {
  private coreApi: CoreV1Api;
  private appsApi: AppsV1Api;

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.appsApi = kc.makeApiClient(AppsV1Api);
  }

  async createNamespace(tenantSlug: string): Promise<string> {
    const namespaceName = `tenant-${tenantSlug}`;
    const namespace: V1Namespace = {
      metadata: {
        name: namespaceName,
        labels: {
          'tenkacloud.io/tenant': tenantSlug,
          'tenkacloud.io/managed-by': 'deployment-management',
        },
      },
    };

    try {
      await this.coreApi.createNamespace({ body: namespace });
      logger.info({ namespace: namespaceName }, 'Namespace を作成しました');
    } catch (error: unknown) {
      const err = error as { response?: { statusCode?: number } };
      if (err.response?.statusCode === 409) {
        logger.info({ namespace: namespaceName }, 'Namespace は既に存在します');
      } else {
        logger.error(
          { error, namespace: namespaceName },
          'Namespace 作成に失敗しました'
        );
        throw error;
      }
    }
    return namespaceName;
  }

  async createDeployment(
    namespace: string,
    serviceName: string,
    image: string,
    replicas: number
  ): Promise<void> {
    const deployment: V1Deployment = {
      metadata: { name: serviceName },
      spec: {
        replicas,
        selector: { matchLabels: { app: serviceName } },
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: {
            maxUnavailable: 0,
            maxSurge: 1,
          },
        },
        template: {
          metadata: { labels: { app: serviceName } },
          spec: {
            containers: [
              {
                name: serviceName,
                image,
                ports: [{ containerPort: 3000 }],
              },
            ],
          },
        },
      },
    };

    await this.appsApi.createNamespacedDeployment({
      namespace,
      body: deployment,
    });
    logger.info({ serviceName, namespace }, 'Deployment を作成しました');
  }

  async updateDeployment(
    namespace: string,
    serviceName: string,
    image: string,
    replicas: number
  ): Promise<void> {
    const deployment: V1Deployment = {
      metadata: { name: serviceName },
      spec: {
        replicas,
        selector: { matchLabels: { app: serviceName } },
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: {
            maxUnavailable: 0,
            maxSurge: 1,
          },
        },
        template: {
          metadata: { labels: { app: serviceName } },
          spec: {
            containers: [
              {
                name: serviceName,
                image,
                ports: [{ containerPort: 3000 }],
              },
            ],
          },
        },
      },
    };

    await this.appsApi.replaceNamespacedDeployment({
      name: serviceName,
      namespace,
      body: deployment,
    });
    logger.info({ serviceName, namespace, image }, 'Deployment を更新しました');
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
    try {
      const response = await this.appsApi.readNamespacedDeployment({
        name: serviceName,
        namespace,
      });
      const status = response.status;
      return {
        availableReplicas: status?.availableReplicas ?? 0,
        readyReplicas: status?.readyReplicas ?? 0,
        replicas: status?.replicas ?? 0,
        updatedReplicas: status?.updatedReplicas ?? 0,
      };
    } catch (error: unknown) {
      const err = error as { response?: { statusCode?: number } };
      if (err.response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async createService(
    namespace: string,
    serviceName: string,
    port: number
  ): Promise<void> {
    const service: V1Service = {
      metadata: { name: serviceName },
      spec: {
        selector: { app: serviceName },
        ports: [{ port, targetPort: 3000 }],
        type: 'ClusterIP',
      },
    };

    try {
      await this.coreApi.createNamespacedService({ namespace, body: service });
      logger.info({ serviceName, namespace }, 'Service を作成しました');
    } catch (error: unknown) {
      const err = error as { response?: { statusCode?: number } };
      if (err.response?.statusCode === 409) {
        logger.info({ serviceName, namespace }, 'Service は既に存在します');
      } else {
        throw error;
      }
    }
  }
}
