import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantRepository } from './tenant-repository';

const mockSend = vi.fn();

vi.mock('./client', () => ({
  getDocClient: () => ({ send: mockSend }),
  getTableName: () => 'TestTable',
}));

vi.mock('ulid', () => ({
  ulid: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
}));

const validTenantItem = {
  PK: 'TENANT#01ARZ3NDEKTSV4RRFFQ69G5FAV',
  SK: 'METADATA',
  EntityType: 'TENANT',
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'テストテナント',
  slug: 'test-tenant',
  status: 'ACTIVE',
  tier: 'FREE',
  adminEmail: 'admin@example.com',
  region: 'ap-northeast-1',
  isolationModel: 'POOL',
  computeType: 'SERVERLESS',
  provisioningStatus: 'PENDING',
  CreatedAt: '2024-01-01T00:00:00Z',
  UpdatedAt: '2024-01-01T00:00:00Z',
};

describe('TenantRepository', () => {
  let repo: TenantRepository;

  beforeEach(() => {
    repo = new TenantRepository();
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('正常なTENANTエンティティのみ返すべき', async () => {
      mockSend.mockResolvedValue({
        Items: [validTenantItem],
        LastEvaluatedKey: undefined,
      });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(1);
      expect(result.tenants[0].id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('EntityTypeがTENANT以外のアイテムをフィルタリングすべき', async () => {
      const eventItem = {
        ...validTenantItem,
        EntityType: 'EVENT',
        PK: 'EVENT#01ARZ3NDEKTSV4RRFFQ69G5FAV',
      };
      mockSend.mockResolvedValue({
        Items: [validTenantItem, eventItem],
        LastEvaluatedKey: undefined,
      });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(1);
      expect(result.tenants[0].id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('idが存在しないアイテムをフィルタリングすべき', async () => {
      const noIdItem = {
        ...validTenantItem,
        id: undefined,
      };
      mockSend.mockResolvedValue({
        Items: [noIdItem, validTenantItem],
        LastEvaluatedKey: undefined,
      });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(2);
      expect(result.tenants[0].id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('legacy item は PK から tenant id を復元して返すべき', async () => {
      const legacyItem = {
        ...validTenantItem,
        id: undefined,
      };
      mockSend.mockResolvedValue({
        Items: [legacyItem],
        LastEvaluatedKey: undefined,
      });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(1);
      expect(result.tenants[0].id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('idが空文字でも PK から tenant id を復元すべき', async () => {
      const emptyIdItem = { ...validTenantItem, id: '' };
      mockSend.mockResolvedValue({
        Items: [emptyIdItem, validTenantItem],
        LastEvaluatedKey: undefined,
      });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(2);
      expect(result.tenants[0].id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('アイテムが空の場合は空配列を返すべき', async () => {
      mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

      const result = await repo.list();

      expect(result.tenants).toHaveLength(0);
    });
  });

  describe('findBySlug', () => {
    it('EntityTypeがTENANTのアイテムのみ返すべき', async () => {
      mockSend.mockResolvedValue({ Items: [validTenantItem] });

      const result = await repo.findBySlug('test-tenant');

      expect(result).not.toBeNull();
      expect(result?.slug).toBe('test-tenant');
    });

    it('EntityTypeがTENANT以外のアイテムが返っても nullを返すべき', async () => {
      const eventItem = { ...validTenantItem, EntityType: 'EVENT' };
      mockSend.mockResolvedValue({ Items: [eventItem] });

      const result = await repo.findBySlug('test-tenant');

      expect(result).toBeNull();
    });

    it('アイテムが空の場合はnullを返すべき', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = await repo.findBySlug('no-such-slug');

      expect(result).toBeNull();
    });
  });

  describe('count', () => {
    it('tenant metadata の件数だけ合計すべき', async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [
            validTenantItem,
            {
              ...validTenantItem,
              PK: 'EVENT#01ARZ3NDEKTSV4RRFFQ69G5FAV',
              EntityType: 'EVENT',
            },
          ],
          LastEvaluatedKey: { PK: 'x' },
        })
        .mockResolvedValueOnce({
          Items: [
            {
              ...validTenantItem,
              PK: 'TENANT#01ARZ3NDEKTSV4RRFFQ69G5FAA',
              id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
            },
            {
              ...validTenantItem,
              PK: 'SYSTEM#SETTING',
              SK: 'KEY#platform',
              EntityType: 'SYSTEM_SETTING',
            },
          ],
          LastEvaluatedKey: undefined,
        });

      const result = await repo.count();

      expect(result).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
