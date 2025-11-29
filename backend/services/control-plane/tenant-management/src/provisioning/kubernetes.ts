import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  NetworkingV1Api,
} from '@kubernetes/client-node';
import { createLogger } from '../lib/logger';

const logger = createLogger('k8s-provisioner');

export class KubernetesProvisioner {
  private k8sApi: CoreV1Api;
  private k8sAppsApi: AppsV1Api;
  private k8sNetworkingApi: NetworkingV1Api;

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.k8sApi = kc.makeApiClient(CoreV1Api);
    this.k8sAppsApi = kc.makeApiClient(AppsV1Api);
    this.k8sNetworkingApi = kc.makeApiClient(NetworkingV1Api);
  }

  async createNamespace(tenantSlug: string) {
    const namespaceName = `tenant-${tenantSlug}`;
    try {
      await this.k8sApi.createNamespace({
        metadata: {
          name: namespaceName,
          labels: {
            'tenkacloud.io/tenant': tenantSlug,
            'tenkacloud.io/managed-by': 'control-plane',
          },
        },
      });
      logger.info({ namespace: namespaceName }, 'Namespace created');
    } catch (error: any) {
      if (error.response && error.response.statusCode === 409) {
        logger.info({ namespace: namespaceName }, 'Namespace already exists');
      } else {
        logger.error(
          { error, namespace: namespaceName },
          'Failed to create namespace'
        );
        throw error;
      }
    }
    return namespaceName;
  }

  async deployParticipantApp(tenantSlug: string, namespace: string) {
    const appName = `app-${tenantSlug}`;
    const image = 'tenkacloud/participant-app:latest'; // In real world, this would be dynamic

    try {
      // Deployment
      await this.k8sAppsApi.createNamespacedDeployment(namespace, {
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
                  env: [
                    { name: 'TENANT_ID', value: tenantSlug },
                    // Add DB connection info here
                  ],
                },
              ],
            },
          },
        },
      });

      // Service
      await this.k8sApi.createNamespacedService(namespace, {
        metadata: { name: appName },
        spec: {
          selector: { app: appName },
          ports: [{ port: 80, targetPort: 3000 }],
          type: 'ClusterIP',
        },
      });

      // Ingress (Optional for now, assuming we use port-forward or similar for local)
      // For local development with kind/minikube, we might need NodePort or Ingress Controller

      logger.info({ appName, namespace }, 'Participant app deployed');
    } catch (error: any) {
      if (error.response && error.response.statusCode === 409) {
        logger.info({ appName, namespace }, 'Deployment already exists');
      } else {
        logger.error(
          { error, appName, namespace },
          'Failed to deploy participant app'
        );
        throw error;
      }
    }
  }
}
