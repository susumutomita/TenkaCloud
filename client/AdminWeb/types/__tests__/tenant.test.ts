import { describe, expect, it } from 'vitest';
import {
  TENANT_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_TIER_LABELS,
  TENANT_TIERS,
  TIER_FEATURES,
  type SupportLevel,
  type Tenant,
  type TenantStatus,
  type TenantTier,
  type TierFeatures,
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

  describe('TIER_FEATURES', () => {
    it('すべてのTierに対応する機能定義を持つべき', () => {
      for (const tier of TENANT_TIERS) {
        expect(TIER_FEATURES[tier]).toBeDefined();
      }
    });

    it('FREE Tierは基本的な制限を持つべき', () => {
      const features = TIER_FEATURES.FREE;
      expect(features.maxParticipants).toBe(10);
      expect(features.maxBattles).toBe(5);
      expect(features.maxProblems).toBe(20);
      expect(features.customBranding).toBe(false);
      expect(features.apiAccess).toBe(false);
      expect(features.ssoEnabled).toBe(false);
      expect(features.supportLevel).toBe('community');
      expect(features.isolationModel).toBe('POOL');
    });

    it('PRO Tierは拡張機能を持つべき', () => {
      const features = TIER_FEATURES.PRO;
      expect(features.maxParticipants).toBe(100);
      expect(features.maxBattles).toBe(50);
      expect(features.maxProblems).toBe(200);
      expect(features.customBranding).toBe(true);
      expect(features.apiAccess).toBe(true);
      expect(features.ssoEnabled).toBe(false);
      expect(features.supportLevel).toBe('email');
      expect(features.isolationModel).toBe('POOL');
    });

    it('ENTERPRISE Tierは無制限と専用環境を持つべき', () => {
      const features = TIER_FEATURES.ENTERPRISE;
      expect(features.maxParticipants).toBe(-1); // 無制限
      expect(features.maxBattles).toBe(-1);
      expect(features.maxProblems).toBe(-1);
      expect(features.customBranding).toBe(true);
      expect(features.apiAccess).toBe(true);
      expect(features.ssoEnabled).toBe(true);
      expect(features.supportLevel).toBe('priority');
      expect(features.isolationModel).toBe('SILO');
    });

    it('TierFeatures型が正しい構造を持つべき', () => {
      const features: TierFeatures = {
        maxParticipants: 10,
        maxBattles: 5,
        maxProblems: 20,
        customBranding: false,
        apiAccess: false,
        ssoEnabled: false,
        supportLevel: 'community',
        isolationModel: 'POOL',
      };
      expect(features).toBeDefined();
    });

    it('SupportLevel型が有効な値のみを受け入れるべき', () => {
      const levels: SupportLevel[] = ['community', 'email', 'priority'];
      expect(levels).toHaveLength(3);
    });
  });

  describe('Tenant インターフェース', () => {
    it('有効なTenantオブジェクトを作成できるべき', () => {
      const tenant: Tenant = {
        id: '1',
        name: 'Test Tenant',
        slug: 'test-tenant',
        status: 'ACTIVE',
        tier: 'FREE',
        adminEmail: 'admin@example.com',
        region: 'ap-northeast-1',
        isolationModel: 'POOL',
        computeType: 'SERVERLESS',
        provisioningStatus: 'COMPLETED',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(tenant.id).toBe('1');
      expect(tenant.name).toBe('Test Tenant');
      expect(tenant.slug).toBe('test-tenant');
      expect(tenant.status).toBe('ACTIVE');
      expect(tenant.tier).toBe('FREE');
      expect(tenant.adminEmail).toBe('admin@example.com');
      expect(tenant.region).toBe('ap-northeast-1');
      expect(tenant.isolationModel).toBe('POOL');
      expect(tenant.computeType).toBe('SERVERLESS');
      expect(tenant.provisioningStatus).toBe('COMPLETED');
      expect(tenant.createdAt).toBe('2024-01-01T00:00:00Z');
      expect(tenant.updatedAt).toBe('2024-01-01T00:00:00Z');
    });
  });
});
