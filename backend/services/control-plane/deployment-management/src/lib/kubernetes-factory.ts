import { KubernetesClient } from './kubernetes';
import { MockKubernetesClient } from './kubernetes-mock';

export type K8sClient = KubernetesClient | MockKubernetesClient;

export function createK8sClient(): K8sClient {
  if (process.env.MOCK_K8S === 'true') {
    return new MockKubernetesClient();
  }
  return new KubernetesClient();
}
