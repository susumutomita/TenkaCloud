import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsService } from './settings';
import { prisma } from '../lib/prisma';
import type { AuditService } from './audit';

vi.mock('../lib/prisma', () => ({
  prisma: {
    systemSetting: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

describe('SettingsService', () => {
  let service: SettingsService;
  let mockAuditService: {
    createLog: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockAuditService = {
      createLog: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    service = new SettingsService(mockAuditService as unknown as AuditService);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSetting', () => {
    it('設定を作成すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedAt: new Date(),
        updatedBy: 'user-1',
      };

      vi.mocked(prisma.systemSetting.create).mockResolvedValue(mockSetting);

      const result = await service.createSetting({
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedBy: 'user-1',
      });

      expect(result).toEqual(mockSetting);
      expect(prisma.systemSetting.create).toHaveBeenCalledWith({
        data: {
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
          updatedBy: 'user-1',
        },
      });
    });
  });

  describe('getSettingByKey', () => {
    it('キーで設定を取得すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedAt: new Date(),
        updatedBy: 'user-1',
      };

      vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(mockSetting);

      const result = await service.getSettingByKey('app.theme');

      expect(result).toEqual(mockSetting);
      expect(prisma.systemSetting.findUnique).toHaveBeenCalledWith({
        where: { key: 'app.theme' },
      });
    });

    it('存在しないキーの場合、nullを返すべき', async () => {
      vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(null);

      const result = await service.getSettingByKey('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateSetting', () => {
    it('設定を更新すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: false },
        category: 'appearance',
        updatedAt: new Date(),
        updatedBy: 'user-2',
      };

      vi.mocked(prisma.systemSetting.update).mockResolvedValue(mockSetting);

      const result = await service.updateSetting('app.theme', {
        value: { dark: false },
        updatedBy: 'user-2',
      });

      expect(result).toEqual(mockSetting);
      expect(prisma.systemSetting.update).toHaveBeenCalledWith({
        where: { key: 'app.theme' },
        data: {
          value: { dark: false },
          updatedBy: 'user-2',
        },
      });
    });
  });

  describe('deleteSetting', () => {
    it('設定を削除し監査ログを記録すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedAt: new Date(),
        updatedBy: null,
      };

      vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(mockSetting);
      vi.mocked(prisma.systemSetting.delete).mockResolvedValue(mockSetting);

      await service.deleteSetting('app.theme', {
        userId: 'user-1',
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
      });

      expect(prisma.systemSetting.findUnique).toHaveBeenCalledWith({
        where: { key: 'app.theme' },
      });
      expect(prisma.systemSetting.delete).toHaveBeenCalledWith({
        where: { key: 'app.theme' },
      });
      expect(mockAuditService.createLog).toHaveBeenCalledWith({
        userId: 'user-1',
        action: 'DELETE',
        resourceType: 'SETTING',
        resourceId: 'setting-1',
        details: { key: 'app.theme', category: 'appearance' },
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
      });
    });

    it('存在しない設定でも監査ログを記録すべき', async () => {
      vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.systemSetting.delete).mockResolvedValue({
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedAt: new Date(),
        updatedBy: null,
      });

      await service.deleteSetting('app.theme', {
        userId: 'user-1',
      });

      expect(mockAuditService.createLog).toHaveBeenCalledWith({
        userId: 'user-1',
        action: 'DELETE',
        resourceType: 'SETTING',
        resourceId: undefined,
        details: { key: 'app.theme', category: undefined },
        ipAddress: undefined,
        userAgent: undefined,
      });
    });
  });

  describe('listSettings', () => {
    it('設定一覧を取得すべき', async () => {
      const mockSettings = [
        {
          id: 'setting-1',
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
          updatedAt: new Date(),
          updatedBy: null,
        },
      ];

      vi.mocked(prisma.systemSetting.findMany).mockResolvedValue(mockSettings);
      vi.mocked(prisma.systemSetting.count).mockResolvedValue(1);

      const result = await service.listSettings({});

      expect(result.settings).toEqual(mockSettings);
      expect(result.total).toBe(1);
    });

    it('カテゴリで設定を絞り込むべき', async () => {
      vi.mocked(prisma.systemSetting.findMany).mockResolvedValue([]);
      vi.mocked(prisma.systemSetting.count).mockResolvedValue(0);

      const result = await service.listSettings({
        category: 'security',
        limit: 10,
        offset: 5,
      });

      expect(result.settings).toEqual([]);
      expect(prisma.systemSetting.findMany).toHaveBeenCalledWith({
        where: { category: 'security' },
        take: 10,
        skip: 5,
        orderBy: { key: 'asc' },
      });
    });
  });

  describe('getSettingsByCategory', () => {
    it('カテゴリで設定を取得すべき', async () => {
      const mockSettings = [
        {
          id: 'setting-1',
          key: 'security.mfa',
          value: { enabled: true },
          category: 'security',
          updatedAt: new Date(),
          updatedBy: null,
        },
      ];

      vi.mocked(prisma.systemSetting.findMany).mockResolvedValue(mockSettings);

      const result = await service.getSettingsByCategory('security');

      expect(result).toEqual(mockSettings);
      expect(prisma.systemSetting.findMany).toHaveBeenCalledWith({
        where: { category: 'security' },
        orderBy: { key: 'asc' },
      });
    });
  });
});
