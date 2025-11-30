import { describe, expect, it } from 'vitest';
import {
  TENANT_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_TIER_LABELS,
  TENANT_TIERS,
  type Tenant,
  type TenantStatus,
  type TenantTier,
} from '../tenant';

describe('Tenant 型定義', () => {
  describe('TENANT_STATUSES', () => {
    it('すべてのステータス値を含むべき', () => {
      expect(TENANT_STATUSES).toContain('ACTIVE');
      expect(TENANT_STATUSES).toContain('SUSPENDED');
      expect(TENANT_STATUSES).toContain('ARCHIVED');
    });

    it('3つのステータス値を持つべき', () => {
      expect(TENANT_STATUSES.length).toBe(3);
    });

    it('読み取り専用であるべき', () => {
      // TypeScript の readonly の確認（コンパイル時チェック）
      const statuses: readonly TenantStatus[] = TENANT_STATUSES;
      expect(statuses).toBe(TENANT_STATUSES);
    });
  });

  describe('TENANT_TIERS', () => {
    it('すべてのTier値を含むべき', () => {
      expect(TENANT_TIERS).toContain('FREE');
      expect(TENANT_TIERS).toContain('PRO');
      expect(TENANT_TIERS).toContain('ENTERPRISE');
    });

    it('3つのTier値を持つべき', () => {
      expect(TENANT_TIERS.length).toBe(3);
    });

    it('読み取り専用であるべき', () => {
      const tiers: readonly TenantTier[] = TENANT_TIERS;
      expect(tiers).toBe(TENANT_TIERS);
    });
  });

  describe('TENANT_STATUS_LABELS', () => {
    it('ACTIVE のラベルを持つべき', () => {
      expect(TENANT_STATUS_LABELS.ACTIVE).toBe('Active');
    });

    it('SUSPENDED のラベルを持つべき', () => {
      expect(TENANT_STATUS_LABELS.SUSPENDED).toBe('Suspended');
    });

    it('ARCHIVED のラベルを持つべき', () => {
      expect(TENANT_STATUS_LABELS.ARCHIVED).toBe('Archived');
    });

    it('すべてのステータスに対応するラベルを持つべき', () => {
      for (const status of TENANT_STATUSES) {
        expect(TENANT_STATUS_LABELS[status]).toBeDefined();
      }
    });
  });

  describe('TENANT_TIER_LABELS', () => {
    it('FREE のラベルを持つべき', () => {
      expect(TENANT_TIER_LABELS.FREE).toBe('Free');
    });

    it('PRO のラベルを持つべき', () => {
      expect(TENANT_TIER_LABELS.PRO).toBe('Pro');
    });

    it('ENTERPRISE のラベルを持つべき', () => {
      expect(TENANT_TIER_LABELS.ENTERPRISE).toBe('Enterprise');
    });

    it('すべてのTierに対応するラベルを持つべき', () => {
      for (const tier of TENANT_TIERS) {
        expect(TENANT_TIER_LABELS[tier]).toBeDefined();
      }
    });
  });

  describe('Tenant インターフェース', () => {
    it('有効なTenantオブジェクトを作成できるべき', () => {
      const tenant: Tenant = {
        id: '1',
        name: 'Test Tenant',
        status: 'ACTIVE',
        tier: 'FREE',
        adminEmail: 'admin@example.com',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(tenant.id).toBe('1');
      expect(tenant.name).toBe('Test Tenant');
      expect(tenant.status).toBe('ACTIVE');
      expect(tenant.tier).toBe('FREE');
      expect(tenant.adminEmail).toBe('admin@example.com');
      expect(tenant.createdAt).toBe('2024-01-01T00:00:00Z');
      expect(tenant.updatedAt).toBe('2024-01-01T00:00:00Z');
    });
  });
});
