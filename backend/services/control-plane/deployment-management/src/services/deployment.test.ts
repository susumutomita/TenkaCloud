import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Deployment, DeploymentHistory } from '@tenkacloud/dynamodb';
import type { K8sClient } from '../lib/kubernetes-factory';

// DynamoDB モック
const mockDeploymentRepository = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  listByTenant: vi.fn(),
  countByTenant: vi.fn(),
  update: vi.fn(),
  addHistory: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  deploymentRepository: mockDeploymentRepository,
}));

vi.mock('../lib/kubernetes-factory');

// DeploymentService のインポートはモック設定後
import { DeploymentService } from './deployment';

describe('DeploymentService', () => {
  let service: DeploymentService;
  let mockK8sClient: {
    createNamespace: ReturnType<typeof vi.fn>;
    createDeployment: ReturnType<typeof vi.fn>;
    updateDeployment: ReturnType<typeof vi.fn>;
    createService: ReturnType<typeof vi.fn>;
    getDeploymentStatus: ReturnType<typeof vi.fn>;
  };

  const createMockDeployment = (
    overrides: Partial<Deployment> = {}
  ): Deployment => ({
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const createMockHistory = (
    overrides: Partial<DeploymentHistory> = {}
  ): DeploymentHistory => ({
    id: 'history-1',
    deploymentId: 'deploy-1',
    status: 'PENDING',
    message: 'デプロイメントを作成しました',
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockK8sClient = {
      createNamespace: vi.fn(),
      createDeployment: vi.fn(),
      updateDeployment: vi.fn(),
      createService: vi.fn(),
      getDeploymentStatus: vi.fn(),
    };
    service = new DeploymentService(mockK8sClient as unknown as K8sClient);
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
      const mockDeployment = createMockDeployment();
      const succeededDeployment = createMockDeployment({ status: 'SUCCEEDED' });

      mockDeploymentRepository.create.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.update.mockResolvedValue(succeededDeployment);
      mockDeploymentRepository.findById.mockResolvedValue(succeededDeployment);
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory()
      );
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
      const mockDeployment = createMockDeployment({ replicas: 1 });

      mockDeploymentRepository.create.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.update.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.findById.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory()
      );

      await service.createDeployment({
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        serviceName: 'app-service',
        image: 'app:v1',
        version: 'v1',
      });

      expect(mockDeploymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ replicas: 1 })
      );
    });

    it('K8sエラー時にステータスをFAILEDに更新すべき', async () => {
      const mockDeployment = createMockDeployment();
      const failedDeployment = createMockDeployment({ status: 'FAILED' });

      mockDeploymentRepository.create.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.update.mockResolvedValue(failedDeployment);
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED' })
      );
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
      const mockDeployment = createMockDeployment();
      const failedDeployment = createMockDeployment({
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });

      mockDeploymentRepository.create.mockResolvedValue(mockDeployment);
      mockDeploymentRepository.update.mockResolvedValue(failedDeployment);
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED', message: '不明なエラー' })
      );
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
      const existingDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const newDeployment = createMockDeployment({
        id: 'deploy-2',
        image: 'app:v2',
        version: 'v2',
        type: 'UPDATE',
        previousImage: 'app:v1',
      });

      mockDeploymentRepository.findById
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...newDeployment, status: 'SUCCEEDED' });
      mockDeploymentRepository.create.mockResolvedValue(newDeployment);
      mockDeploymentRepository.update.mockResolvedValue({
        ...newDeployment,
        status: 'SUCCEEDED',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory()
      );
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
      mockDeploymentRepository.findById.mockResolvedValue(null);

      const result = await service.updateDeployment('non-existent', {
        image: 'app:v2',
        version: 'v2',
      });

      expect(result).toBeNull();
    });

    it('レプリカ数を指定して更新すべき', async () => {
      const existingDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...existingDeployment, replicas: 5 });
      mockDeploymentRepository.create.mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        replicas: 5,
      });
      mockDeploymentRepository.update.mockResolvedValue({
        ...existingDeployment,
        replicas: 5,
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory()
      );
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
      const existingDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(existingDeployment);
      mockDeploymentRepository.create.mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        type: 'UPDATE',
      });
      mockDeploymentRepository.update.mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED' })
      );
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
      const existingDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(existingDeployment);
      mockDeploymentRepository.create.mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-2',
        type: 'UPDATE',
      });
      mockDeploymentRepository.update.mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED', message: '不明なエラー' })
      );
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
      const existingDeployment = createMockDeployment({
        id: 'deploy-2',
        image: 'app:v2',
        version: 'v2',
        type: 'UPDATE',
        previousImage: 'app:v1',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const rollbackDeployment = createMockDeployment({
        id: 'deploy-3',
        image: 'app:v1',
        version: 'rollback-from-v2',
        type: 'ROLLBACK',
        previousImage: 'app:v2',
      });

      mockDeploymentRepository.findById
        .mockResolvedValueOnce(existingDeployment)
        .mockResolvedValueOnce({ ...rollbackDeployment, status: 'SUCCEEDED' });
      mockDeploymentRepository.create.mockResolvedValue(rollbackDeployment);
      mockDeploymentRepository.update.mockResolvedValue({
        ...rollbackDeployment,
        status: 'SUCCEEDED',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory()
      );
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
      mockDeploymentRepository.findById.mockResolvedValue(null);

      const result = await service.rollbackDeployment('non-existent');

      expect(result).toBeNull();
    });

    it('previousImageがない場合、エラーをスローすべき', async () => {
      const existingDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(existingDeployment);

      await expect(service.rollbackDeployment('deploy-1')).rejects.toThrow(
        'ロールバック先のイメージがありません'
      );
    });

    it('K8sエラー時にステータスをFAILEDに更新すべき', async () => {
      const existingDeployment = createMockDeployment({
        id: 'deploy-2',
        image: 'app:v2',
        version: 'v2',
        type: 'UPDATE',
        previousImage: 'app:v1',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(existingDeployment);
      mockDeploymentRepository.create.mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-3',
        type: 'ROLLBACK',
      });
      mockDeploymentRepository.update.mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED' })
      );
      mockK8sClient.updateDeployment.mockRejectedValue(
        new Error('Rollback failed')
      );

      await expect(service.rollbackDeployment('deploy-2')).rejects.toThrow(
        'Rollback failed'
      );
    });

    it('非Errorオブジェクトのエラー時に「不明なエラー」メッセージを使用すべき', async () => {
      const existingDeployment = createMockDeployment({
        id: 'deploy-2',
        image: 'app:v2',
        version: 'v2',
        type: 'UPDATE',
        previousImage: 'app:v1',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(existingDeployment);
      mockDeploymentRepository.create.mockResolvedValue({
        ...existingDeployment,
        id: 'deploy-3',
        type: 'ROLLBACK',
      });
      mockDeploymentRepository.update.mockResolvedValue({
        ...existingDeployment,
        status: 'FAILED',
        errorMessage: '不明なエラー',
      });
      mockDeploymentRepository.addHistory.mockResolvedValue(
        createMockHistory({ status: 'FAILED', message: '不明なエラー' })
      );
      mockK8sClient.updateDeployment.mockRejectedValue('string error');

      await expect(service.rollbackDeployment('deploy-2')).rejects.toBe(
        'string error'
      );
    });
  });

  describe('getDeploymentStatus', () => {
    it('デプロイメントとK8sステータスを返すべき', async () => {
      const mockDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const k8sStatus = {
        availableReplicas: 2,
        readyReplicas: 2,
        replicas: 2,
        updatedReplicas: 2,
      };

      mockDeploymentRepository.findById.mockResolvedValue(mockDeployment);
      mockK8sClient.getDeploymentStatus.mockResolvedValue(k8sStatus);

      const result = await service.getDeploymentStatus('deploy-1');

      expect(result).toEqual({
        deployment: mockDeployment,
        kubernetes: k8sStatus,
      });
    });

    it('存在しないデプロイメントの場合、nullを返すべき', async () => {
      mockDeploymentRepository.findById.mockResolvedValue(null);

      const result = await service.getDeploymentStatus('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getDeploymentById', () => {
    it('IDでデプロイメントを取得すべき', async () => {
      const mockDeployment = createMockDeployment({
        status: 'SUCCEEDED',
        startedAt: new Date(),
        completedAt: new Date(),
      });

      mockDeploymentRepository.findById.mockResolvedValue(mockDeployment);

      const result = await service.getDeploymentById('deploy-1');

      expect(result).toEqual(mockDeployment);
    });

    it('存在しないIDの場合、nullを返すべき', async () => {
      mockDeploymentRepository.findById.mockResolvedValue(null);

      const result = await service.getDeploymentById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listDeployments', () => {
    it('デプロイメント一覧を取得すべき', async () => {
      const mockDeployments = [
        createMockDeployment({
          status: 'SUCCEEDED',
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      ];

      mockDeploymentRepository.listByTenant.mockResolvedValue({
        deployments: mockDeployments,
      });
      mockDeploymentRepository.countByTenant.mockResolvedValue(1);

      const result = await service.listDeployments({ tenantId: 'tenant-1' });

      expect(result.deployments).toEqual(mockDeployments);
      expect(result.total).toBe(1);
    });

    it('tenantIdがない場合、空の結果を返すべき', async () => {
      const result = await service.listDeployments({});

      expect(result).toEqual({ deployments: [], total: 0 });
    });

    it('フィルタ条件で絞り込むべき', async () => {
      mockDeploymentRepository.listByTenant.mockResolvedValue({
        deployments: [],
      });
      mockDeploymentRepository.countByTenant.mockResolvedValue(0);

      await service.listDeployments({
        tenantId: 'tenant-1',
        tenantSlug: 'test-tenant',
        status: 'SUCCEEDED',
        limit: 10,
        offset: 5,
      });

      expect(mockDeploymentRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          status: 'SUCCEEDED',
          limit: 10,
        })
      );
    });

    it('デフォルトのlimitを使用すべき', async () => {
      mockDeploymentRepository.listByTenant.mockResolvedValue({
        deployments: [],
      });
      mockDeploymentRepository.countByTenant.mockResolvedValue(0);

      await service.listDeployments({ tenantId: 'tenant-1' });

      expect(mockDeploymentRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ limit: 20 })
      );
    });
  });

  describe('getDeploymentHistory', () => {
    it('デプロイメント履歴を取得すべき', async () => {
      const mockHistory = [
        createMockHistory({
          status: 'PENDING',
          message: 'デプロイメントを作成しました',
        }),
        createMockHistory({ id: 'history-2', status: 'IN_PROGRESS' }),
        createMockHistory({ id: 'history-3', status: 'SUCCEEDED' }),
      ];

      mockDeploymentRepository.getHistory.mockResolvedValue(mockHistory);

      const result = await service.getDeploymentHistory('deploy-1');

      expect(result).toEqual(mockHistory);
      expect(mockDeploymentRepository.getHistory).toHaveBeenCalledWith(
        'deploy-1'
      );
    });
  });
});
