import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createK8sClient } from './kubernetes-factory';
import { KubernetesClient } from './kubernetes';
import { MockKubernetesClient } from './kubernetes-mock';

vi.mock('./kubernetes', () => ({
  KubernetesClient: vi.fn().mockImplementation(() => ({
    createNamespace: vi.fn(),
    createDeployment: vi.fn(),
    updateDeployment: vi.fn(),
    createService: vi.fn(),
    getDeploymentStatus: vi.fn(),
  })),
}));

vi.mock('./kubernetes-mock', () => ({
  MockKubernetesClient: vi.fn().mockImplementation(() => ({
    createNamespace: vi.fn(),
    createDeployment: vi.fn(),
    updateDeployment: vi.fn(),
    createService: vi.fn(),
    getDeploymentStatus: vi.fn(),
  })),
}));

describe('createK8sClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('MOCK_K8S=trueの場合、MockKubernetesClientを返すべき', () => {
    process.env.MOCK_K8S = 'true';

    createK8sClient();

    expect(MockKubernetesClient).toHaveBeenCalled();
    expect(KubernetesClient).not.toHaveBeenCalled();
  });

  it('MOCK_K8S未設定の場合、KubernetesClientを返すべき', () => {
    delete process.env.MOCK_K8S;

    createK8sClient();

    expect(KubernetesClient).toHaveBeenCalled();
    expect(MockKubernetesClient).not.toHaveBeenCalled();
  });

  it('MOCK_K8S=falseの場合、KubernetesClientを返すべき', () => {
    process.env.MOCK_K8S = 'false';

    createK8sClient();

    expect(KubernetesClient).toHaveBeenCalled();
    expect(MockKubernetesClient).not.toHaveBeenCalled();
  });
});
