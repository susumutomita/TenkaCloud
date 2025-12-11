import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeploymentService } from './deployment';
import { prisma } from '../lib/prisma';
import { KubernetesClient } from '../lib/kubernetes';

vi.mock('../lib/prisma', () => ({
  prisma: {
    deployment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    deploymentHistory: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/kubernetes');

describe('DeploymentService', () => {
  let service: DeploymentService;
  let mockK8sClient: {
    createNamespace: ReturnType<typeof vi.fn>;
    createDeployment: ReturnType<typeof vi.fn>;
    updateDeployment: ReturnType<typeof vi.fn>;
    createService: ReturnType<typeof vi.fn>;
    getDeploymentStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockK8sClient = {
      createNamespace: vi.fn(),
      createDeployment: vi.fn(),
      updateDeployment: vi.fn(),
      createService: vi.fn(),
      getDeploymentStatus: vi.fn(),
    };
    service = new DeploymentService(
      mockK8sClient as unknown as KubernetesClient
    );
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('引数なしでデフォルトのKubernetesClientを使用すべき', () => {
      const serviceWithDefaultClient = new DeploymentService();
      expect(serviceWithDefaultClient).toBeDefined();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createDeployment', () => {
    it('デプロイメントを作成すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'PENDING',
        type: 'CREATE',
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      vi.mocked(prisma.deployment.create).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...mockDeployment,
        status: 'SUCCEEDED',
      });
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue({
        ...mockDeployment,
        status: 'SUCCEEDED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-1',
        status: 'PENDING',
        message: 'デプロイメントを作成しました',
        createdAt: new Date(),
      });
      mockK8sClient.createNamespace.mockResolvedValue('tenant-test-tenant');
      mockK8sClient.createDeployment.mockResolvedValue(undefined);
      mockK8sClient.createService.mockResolvedValue(undefined);

      const result = await service.createDeployment({
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
      });

      expect(result?.status).toBe('SUCCEEDED');
      expect(mockK8sClient.createNamespace).toHaveBeenCalledWith('test-tenant');
      expect(mockK8sClient.createDeployment).toHaveBeenCalledWith(
        'tenant-test-tenant',
        'app-service',
        'app:v1',
        2
      );
      expect(mockK8sClient.createService).toHaveBeenCalledWith(
        'tenant-test-tenant',
        'app-service',
        80
      );
    });

    it('デフォルトのレプリカ数（1）で作成すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 1,
        status: 'PENDING',
        type: 'CREATE',
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      vi.mocked(prisma.deployment.create).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-1',
        status: 'PENDING',
        message: null,
        createdAt: new Date(),
      });

      await service.createDeployment({
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
      });

      expect(prisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ replicas: 1 }),
      });
    });

    it('K8sエラー時にステータスをFAILEDに更新すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 1,
        status: 'PENDING',
        type: 'CREATE',
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      vi.mocked(prisma.deployment.create).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...mockDeployment,
        status: 'FAILED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-1',
        status: 'FAILED',
        message: 'K8s error',
        createdAt: new Date(),
      });
      mockK8sClient.createNamespace.mockRejectedValue(new Error('K8s error'));

      await expect(
        service.createDeployment({
          tenantId: 'tenant-1',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: 'app:v1',
          version: 'v1',
        })
      ).rejects.toThrow('K8s error');
    });

    it('非Errorオブジェクトのエラー時に「不明なエラー」メッセージを使用すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 1,
        status: 'PENDING',
        type: 'CREATE',
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      vi.mocked(prisma.deployment.create).mockResolvedValue(mockDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...mockDeployment,
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-1',
        status: 'FAILED',
        message: '不明なエラー',
        createdAt: new Date(),
      });
      mockK8sClient.createNamespace.mockRejectedValue('string error');

      await expect(
        service.createDeployment({
          tenantId: 'tenant-1',
          tenantSlug: 'test-tenant',
          serviceName: 'app-service',
          image: 'app:v1',
          version: 'v1',
        })
      ).rejects.toBe('string error');
    });
  });

  describe('updateDeployment', () => {
    it('ローリングアップデートを実行すべき', async () => {
      const existingDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      const newDeployment = {
        ...existingDeployment,
        id: 'deploy-2',
        image: 'app:v2',
        version: 'v2',
        status: 'PENDING' as const,
        type: 'UPDATE' as const,
        previousImage: 'app:v1',
      };

      vi.mocked(prisma.deployment.findUnique)
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...newDeployment, status: 'SUCCEEDED' });
      vi.mocked(prisma.deployment.create).mockResolvedValue(newDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...newDeployment,
        status: 'SUCCEEDED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-2',
        status: 'PENDING',
        message: null,
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockResolvedValue(undefined);

      const result = await service.updateDeployment('deploy-1', {
        image: 'app:v2',
        version: 'v2',
      });

      expect(result?.status).toBe('SUCCEEDED');
      expect(mockK8sClient.updateDeployment).toHaveBeenCalledWith(
        'tenant-test-tenant',
        'app-service',
        'app:v2',
        2
      );
    });

    it('存在しないデプロイメントの場合、nullを返すべき', async () => {
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(null);

      const result = await service.updateDeployment('non-existent', {
        image: 'app:v2',
        version: 'v2',
      });

      expect(result).toBeNull();
    });

    it('レプリカ数を指定して更新すべき', async () => {
      const existingDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique)
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...existingDeployment, replicas: 5 });
      vi.mocked(prisma.deployment.create).mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        replicas: 5,
      });
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...existingDeployment,
        replicas: 5,
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-2',
        status: 'PENDING',
        message: null,
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockResolvedValue(undefined);

      await service.updateDeployment('deploy-1', {
        image: 'app:v2',
        version: 'v2',
        replicas: 5,
      });

      expect(mockK8sClient.updateDeployment).toHaveBeenCalledWith(
        'tenant-test-tenant',
        'app-service',
        'app:v2',
        5
      );
    });

    it('K8sエラー時にステータスをFAILEDに更新すべき', async () => {
      const existingDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(
        existingDeployment
      );
      vi.mocked(prisma.deployment.create).mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        type: 'UPDATE',
      });
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-2',
        status: 'FAILED',
        message: 'Update failed',
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockRejectedValue(
        new Error('Update failed')
      );

      await expect(
        service.updateDeployment('deploy-1', {
          image: 'app:v2',
          version: 'v2',
        })
      ).rejects.toThrow('Update failed');
    });

    it('非Errorオブジェクトのエラー時に「不明なエラー」メッセージを使用すべき', async () => {
      const existingDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(
        existingDeployment
      );
      vi.mocked(prisma.deployment.create).mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        type: 'UPDATE',
      });
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-2',
        status: 'FAILED',
        message: '不明なエラー',
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockRejectedValue('string error');

      await expect(
        service.updateDeployment('deploy-1', {
          image: 'app:v2',
          version: 'v2',
        })
      ).rejects.toBe('string error');
    });
  });

  describe('rollbackDeployment', () => {
    it('ロールバックを実行すべき', async () => {
      const existingDeployment = {
        id: 'deploy-2',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v2',
        version: 'v2',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'UPDATE' as const,
        previousImage: 'app:v1',
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      const rollbackDeployment = {
        ...existingDeployment,
        id: 'deploy-3',
        image: 'app:v1',
        version: 'rollback-from-v2',
        type: 'ROLLBACK' as const,
        previousImage: 'app:v2',
      };

      vi.mocked(prisma.deployment.findUnique)
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...rollbackDeployment, status: 'SUCCEEDED' });
      vi.mocked(prisma.deployment.create).mockResolvedValue(rollbackDeployment);
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...rollbackDeployment,
        status: 'SUCCEEDED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-3',
        status: 'PENDING',
        message: null,
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockResolvedValue(undefined);

      const result = await service.rollbackDeployment('deploy-2');

      expect(result?.status).toBe('SUCCEEDED');
      expect(mockK8sClient.updateDeployment).toHaveBeenCalledWith(
        'tenant-test-tenant',
        'app-service',
        'app:v1',
        2
      );
    });

    it('存在しないデプロイメントの場合、nullを返すべき', async () => {
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(null);

      const result = await service.rollbackDeployment('non-existent');

      expect(result).toBeNull();
    });

    it('previousImageがない場合、エラーをスローすべき', async () => {
      const existingDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(
        existingDeployment
      );

      await expect(service.rollbackDeployment('deploy-1')).rejects.toThrow(
        'ロールバック先のイメージがありません'
      );
    });

    it('K8sエラー時にステータスをFAILEDに更新すべき', async () => {
      const existingDeployment = {
        id: 'deploy-2',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v2',
        version: 'v2',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'UPDATE' as const,
        previousImage: 'app:v1',
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(
        existingDeployment
      );
      vi.mocked(prisma.deployment.create).mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-3',
        type: 'ROLLBACK',
      });
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-3',
        status: 'FAILED',
        message: 'Rollback failed',
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockRejectedValue(
        new Error('Rollback failed')
      );

      await expect(service.rollbackDeployment('deploy-2')).rejects.toThrow(
        'Rollback failed'
      );
    });

    it('非Errorオブジェクトのエラー時に「不明なエラー」メッセージを使用すべき', async () => {
      const existingDeployment = {
        id: 'deploy-2',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v2',
        version: 'v2',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'UPDATE' as const,
        previousImage: 'app:v1',
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(
        existingDeployment
      );
      vi.mocked(prisma.deployment.create).mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-3',
        type: 'ROLLBACK',
      });
      vi.mocked(prisma.deployment.update).mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });
      vi.mocked(prisma.deploymentHistory.create).mockResolvedValue({
        id: 'history-1',
        deploymentId: 'deploy-3',
        status: 'FAILED',
        message: '不明なエラー',
        createdAt: new Date(),
      });
      mockK8sClient.updateDeployment.mockRejectedValue('string error');

      await expect(service.rollbackDeployment('deploy-2')).rejects.toBe(
        'string error'
      );
    });
  });

  describe('getDeploymentStatus', () => {
    it('デプロイメントとK8sステータスを返すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      const k8sStatus = {
        availableReplicas: 2,
        readyReplicas: 2,
        replicas: 2,
        updatedReplicas: 2,
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(mockDeployment);
      mockK8sClient.getDeploymentStatus.mockResolvedValue(k8sStatus);

      const result = await service.getDeploymentStatus('deploy-1');

      expect(result).toEqual({
        deployment: mockDeployment,
        kubernetes: k8sStatus,
      });
    });

    it('存在しないデプロイメントの場合、nullを返すべき', async () => {
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(null);

      const result = await service.getDeploymentStatus('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getDeploymentById', () => {
    it('IDでデプロイメントを取得すべき', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        namespace: 'tenant-test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
        replicas: 2,
        status: 'SUCCEEDED' as const,
        type: 'CREATE' as const,
        previousImage: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(mockDeployment);

      const result = await service.getDeploymentById('deploy-1');

      expect(result).toEqual(mockDeployment);
    });

    it('存在しないIDの場合、nullを返すべき', async () => {
      vi.mocked(prisma.deployment.findUnique).mockResolvedValue(null);

      const result = await service.getDeploymentById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listDeployments', () => {
    it('デプロイメント一覧を取得すべき', async () => {
      const mockDeployments = [
        {
          id: 'deploy-1',
          tenantId: 'tenant-1',
          tenantSlug: 'test-tenant',
          namespace: 'tenant-test-tenant',
          serviceName: 'app-service',
          image: 'app:v1',
          version: 'v1',
          replicas: 2,
          status: 'SUCCEEDED' as const,
          type: 'CREATE' as const,
          previousImage: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ];

      vi.mocked(prisma.deployment.findMany).mockResolvedValue(mockDeployments);
      vi.mocked(prisma.deployment.count).mockResolvedValue(1);

      const result = await service.listDeployments({ tenantId: 'tenant-1' });

      expect(result.deployments).toEqual(mockDeployments);
      expect(result.total).toBe(1);
    });

    it('フィルタ条件で絞り込むべき', async () => {
      vi.mocked(prisma.deployment.findMany).mockResolvedValue([]);
      vi.mocked(prisma.deployment.count).mockResolvedValue(0);

      await service.listDeployments({
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        status: 'SUCCEEDED',
        limit: 10,
        offset: 5,
      });

      expect(prisma.deployment.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          tenantSlug: 'test-tenant',
          status: 'SUCCEEDED',
        },
        take: 10,
        skip: 5,
        orderBy: { createdAt: 'desc' },
      });
    });

    it('デフォルトのlimitとoffsetを使用すべき', async () => {
      vi.mocked(prisma.deployment.findMany).mockResolvedValue([]);
      vi.mocked(prisma.deployment.count).mockResolvedValue(0);

      await service.listDeployments({});

      expect(prisma.deployment.findMany).toHaveBeenCalledWith({
        where: {},
        take: 20,
        skip: 0,
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('getDeploymentHistory', () => {
    it('デプロイメント履歴を取得すべき', async () => {
      const mockHistory = [
        {
          id: 'history-1',
          deploymentId: 'deploy-1',
          status: 'PENDING' as const,
          message: 'デプロイメントを作成しました',
          createdAt: new Date(),
        },
        {
          id: 'history-2',
          deploymentId: 'deploy-1',
          status: 'IN_PROGRESS' as const,
          message: null,
          createdAt: new Date(),
        },
        {
          id: 'history-3',
          deploymentId: 'deploy-1',
          status: 'SUCCEEDED' as const,
          message: null,
          createdAt: new Date(),
        },
      ];

      vi.mocked(prisma.deploymentHistory.findMany).mockResolvedValue(
        mockHistory
      );

      const result = await service.getDeploymentHistory('deploy-1');

      expect(result).toEqual(mockHistory);
      expect(prisma.deploymentHistory.findMany).toHaveBeenCalledWith({
        where: { deploymentId: 'deploy-1' },
        orderBy: { createdAt: 'asc' },
      });
    });
  });
});
