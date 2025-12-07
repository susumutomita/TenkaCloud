import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  V1Namespace,
  V1Deployment,
  V1Service,
} from '@kubernetes/client-node';
import { createLogger } from '../lib/logger';

const logger = createLogger('k8s-provisioner');

export class KubernetesProvisioner {
  private k8sApi: CoreV1Api;
  private k8sAppsApi: AppsV1Api;

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.k8sApi = kc.makeApiClient(CoreV1Api);
    this.k8sAppsApi = kc.makeApiClient(AppsV1Api);
  }

  async createNamespace(tenantSlug: string): Promise<string> {
    const namespaceName = `tenant-${tenantSlug}`;
    const namespace: V1Namespace = {
      metadata: {
        name: namespaceName,
        labels: {
          'tenkacloud.io/tenant': tenantSlug,
          'tenkacloud.io/managed-by': 'control-plane',
        },
      },
    };

    try {
      await this.k8sApi.createNamespace({ body: namespace });
      logger.info({ namespace: namespaceName }, 'Namespaceを作成しました');
    } catch (error: unknown) {
      const err = error as { response?: { statusCode?: number } };
      if (err.response?.statusCode === 409) {
        logger.info({ namespace: namespaceName }, 'Namespaceは既に存在します');
      } else {
        logger.error(
          { error, namespace: namespaceName },
          'Namespace作成に失敗しました'
        );
        throw error;
      }
    }
    return namespaceName;
  }

  async deployParticipantApp(
    tenantSlug: string,
    namespace: string
  ): Promise<void> {
    const appName = `app-${tenantSlug}`;
    const image =
      process.env.PARTICIPANT_APP_IMAGE || 'tenkacloud/participant-app:latest';

    const deployment: V1Deployment = {
      metadata: { name: appName },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: appName } },
        template: {
          metadata: { labels: { app: appName } },
          spec: {
            containers: [
              {
                name: 'app',
                image: image,
                ports: [{ containerPort: 3000 }],
                env: [{ name: 'TENANT_ID', value: tenantSlug }],
              },
            ],
          },
        },
      },
    };

    const service: V1Service = {
      metadata: { name: appName },
      spec: {
        selector: { app: appName },
        ports: [{ port: 80, targetPort: 3000 }],
        type: 'ClusterIP',
      },
    };

    try {
      // Deployment
      await this.k8sAppsApi.createNamespacedDeployment({
        namespace,
        body: deployment,
      });

      // Service
      await this.k8sApi.createNamespacedService({
        namespace,
        body: service,
      });

      logger.info({ appName, namespace }, 'Participant Appをデプロイしました');
    } catch (error: unknown) {
      const err = error as { response?: { statusCode?: number } };
      if (err.response?.statusCode === 409) {
        logger.info({ appName, namespace }, 'Deploymentは既に存在します');
      } else {
        logger.error(
          { error, appName, namespace },
          'Participant Appのデプロイに失敗しました'
        );
        throw error;
      }
    }
  }
}
