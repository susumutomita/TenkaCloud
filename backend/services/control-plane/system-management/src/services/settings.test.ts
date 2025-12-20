import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsService } from './settings';
import type { AuditService } from './audit';
import type { SystemSetting } from '@tenkacloud/dynamodb';

const mockSystemSettingRepository = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  listByCategory: vi.fn(),
  listAll: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  systemSettingRepository: mockSystemSettingRepository,
}));

const createMockSetting = (
  overrides: Partial<SystemSetting> = {}
): SystemSetting => ({
  key: 'app.theme',
  value: { dark: true },
  category: 'appearance',
  updatedBy: 'user-1',
  updatedAt: new Date(),
  ...overrides,
});

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
      const mockSetting = createMockSetting();

      mockSystemSettingRepository.set.mockResolvedValue(mockSetting);

      const result = await service.createSetting({
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedBy: 'user-1',
      });

      expect(result).toEqual(mockSetting);
      expect(mockSystemSettingRepository.set).toHaveBeenCalledWith({
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedBy: 'user-1',
      });
    });
  });

  describe('getSettingByKey', () => {
    it('キーで設定を取得すべき', async () => {
      const mockSetting = createMockSetting();

      mockSystemSettingRepository.get.mockResolvedValue(mockSetting);

      const result = await service.getSettingByKey('app.theme');

      expect(result).toEqual(mockSetting);
      expect(mockSystemSettingRepository.get).toHaveBeenCalledWith('app.theme');
    });

    it('存在しないキーの場合、nullを返すべき', async () => {
      mockSystemSettingRepository.get.mockResolvedValue(null);

      const result = await service.getSettingByKey('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateSetting', () => {
    it('設定を更新すべき', async () => {
      const existingSetting = createMockSetting();
      const updatedSetting = createMockSetting({
        value: { dark: false },
        updatedBy: 'user-2',
      });

      mockSystemSettingRepository.get.mockResolvedValue(existingSetting);
      mockSystemSettingRepository.set.mockResolvedValue(updatedSetting);

      const result = await service.updateSetting('app.theme', {
        value: { dark: false },
        updatedBy: 'user-2',
      });

      expect(result).toEqual(updatedSetting);
      expect(mockSystemSettingRepository.set).toHaveBeenCalledWith({
        key: 'app.theme',
        value: { dark: false },
        category: 'appearance',
        updatedBy: 'user-2',
      });
    });

    it('存在しないキーの場合、エラーを投げるべき', async () => {
      mockSystemSettingRepository.get.mockResolvedValue(null);

      await expect(
        service.updateSetting('non-existent', {
          value: { dark: false },
          updatedBy: 'user-1',
        })
      ).rejects.toThrow('設定が見つかりません: non-existent');
    });
  });

  describe('deleteSetting', () => {
    it('設定を削除し監査ログを記録すべき', async () => {
      const mockSetting = createMockSetting();

      mockSystemSettingRepository.get.mockResolvedValue(mockSetting);
      mockSystemSettingRepository.delete.mockResolvedValue(undefined);

      await service.deleteSetting('app.theme', {
        userId: 'user-1',
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
      });

      expect(mockSystemSettingRepository.get).toHaveBeenCalledWith('app.theme');
      expect(mockSystemSettingRepository.delete).toHaveBeenCalledWith(
        'app.theme'
      );
      expect(mockAuditService.createLog).toHaveBeenCalledWith({
        userId: 'user-1',
        action: 'DELETE',
        resourceType: 'SETTING',
        resourceId: 'app.theme',
        details: { key: 'app.theme', category: 'appearance' },
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
      });
    });

    it('存在しない設定でも監査ログを記録すべき', async () => {
      mockSystemSettingRepository.get.mockResolvedValue(null);
      mockSystemSettingRepository.delete.mockResolvedValue(undefined);

      await service.deleteSetting('app.theme', {
        userId: 'user-1',
      });

      expect(mockAuditService.createLog).toHaveBeenCalledWith({
        userId: 'user-1',
        action: 'DELETE',
        resourceType: 'SETTING',
        resourceId: 'app.theme',
        details: { key: 'app.theme', category: undefined },
        ipAddress: undefined,
        userAgent: undefined,
      });
    });
  });

  describe('listSettings', () => {
    it('設定一覧を取得すべき', async () => {
      const mockSettings = [createMockSetting()];

      mockSystemSettingRepository.listAll.mockResolvedValue(mockSettings);

      const result = await service.listSettings({});

      expect(result.settings).toEqual(mockSettings);
      expect(result.total).toBe(1);
    });

    it('カテゴリで設定を絞り込むべき', async () => {
      mockSystemSettingRepository.listByCategory.mockResolvedValue([]);

      const result = await service.listSettings({
        category: 'security',
        limit: 10,
        offset: 5,
      });

      expect(result.settings).toEqual([]);
      expect(mockSystemSettingRepository.listByCategory).toHaveBeenCalledWith(
        'security'
      );
    });

    it('ページネーションが機能すべき', async () => {
      const mockSettings = [
        createMockSetting({ key: 'setting-1' }),
        createMockSetting({ key: 'setting-2' }),
        createMockSetting({ key: 'setting-3' }),
      ];

      mockSystemSettingRepository.listAll.mockResolvedValue(mockSettings);

      const result = await service.listSettings({
        limit: 1,
        offset: 1,
      });

      expect(result.settings).toHaveLength(1);
      expect(result.settings[0].key).toBe('setting-2');
      expect(result.total).toBe(3);
    });
  });

  describe('getSettingsByCategory', () => {
    it('カテゴリで設定を取得すべき', async () => {
      const mockSettings = [
        createMockSetting({ key: 'security.mfa', category: 'security' }),
      ];

      mockSystemSettingRepository.listByCategory.mockResolvedValue(
        mockSettings
      );

      const result = await service.getSettingsByCategory('security');

      expect(result).toEqual(mockSettings);
      expect(mockSystemSettingRepository.listByCategory).toHaveBeenCalledWith(
        'security'
      );
    });
  });
});
