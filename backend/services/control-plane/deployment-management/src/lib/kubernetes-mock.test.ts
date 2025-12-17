import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockKubernetesClient } from './kubernetes-mock';

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('MockKubernetesClient', () => {
  let client: MockKubernetesClient;

  beforeEach(() => {
    client = new MockKubernetesClient();
  });

  describe('createNamespace', () => {
    it('Namespace名をtenant-{slug}形式で返すべき', async () => {
      const result = await client.createNamespace('test-tenant');
      expect(result).toBe('tenant-test-tenant');
    });

    it('同じNamespaceを複数回作成しても成功すべき', async () => {
      await client.createNamespace('test-tenant');
      const result = await client.createNamespace('test-tenant');
      expect(result).toBe('tenant-test-tenant');
    });
  });

  describe('createDeployment', () => {
    it('Deploymentを作成すべき', async () => {
      await expect(
        client.createDeployment('test-ns', 'test-service', 'test-image:v1', 3)
      ).resolves.toBeUndefined();
    });

    it('作成後にgetDeploymentStatusでステータスを取得できるべき', async () => {
      await client.createDeployment(
        'test-ns',
        'test-service',
        'test-image:v1',
        3
      );
      const status = await client.getDeploymentStatus(
        'test-ns',
        'test-service'
      );

      expect(status).toEqual({
        availableReplicas: 3,
        readyReplicas: 3,
        replicas: 3,
        updatedReplicas: 3,
      });
    });
  });

  describe('updateDeployment', () => {
    it('Deploymentを更新すべき', async () => {
      await client.createDeployment(
        'test-ns',
        'test-service',
        'test-image:v1',
        2
      );
      await expect(
        client.updateDeployment('test-ns', 'test-service', 'test-image:v2', 4)
      ).resolves.toBeUndefined();
    });

    it('更新後のステータスが反映されるべき', async () => {
      await client.createDeployment(
        'test-ns',
        'test-service',
        'test-image:v1',
        2
      );
      await client.updateDeployment(
        'test-ns',
        'test-service',
        'test-image:v2',
        5
      );

      const status = await client.getDeploymentStatus(
        'test-ns',
        'test-service'
      );
      expect(status?.replicas).toBe(5);
    });
  });

  describe('getDeploymentStatus', () => {
    it('存在しないDeploymentの場合はnullを返すべき', async () => {
      const status = await client.getDeploymentStatus(
        'non-existent',
        'service'
      );
      expect(status).toBeNull();
    });

    it('存在するDeploymentのステータスを返すべき', async () => {
      await client.createDeployment(
        'test-ns',
        'test-service',
        'test-image:v1',
        2
      );
      const status = await client.getDeploymentStatus(
        'test-ns',
        'test-service'
      );

      expect(status).toEqual({
        availableReplicas: 2,
        readyReplicas: 2,
        replicas: 2,
        updatedReplicas: 2,
      });
    });
  });

  describe('createService', () => {
    it('Serviceを作成すべき', async () => {
      await expect(
        client.createService('test-ns', 'test-service', 80)
      ).resolves.toBeUndefined();
    });

    it('同じServiceを複数回作成しても成功すべき', async () => {
      await client.createService('test-ns', 'test-service', 80);
      await expect(
        client.createService('test-ns', 'test-service', 80)
      ).resolves.toBeUndefined();
    });
  });
});
