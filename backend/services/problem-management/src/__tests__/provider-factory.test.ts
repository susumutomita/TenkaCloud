/**
 * Cloud Provider Factory Tests
 *
 * クラウドプロバイダーファクトリーの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CloudProviderFactory,
  getCloudProviderFactory,
  getCloudProvider,
} from '../providers/factory';
import type { ICloudProvider } from '../providers/interface';
import type { CloudProvider as CloudProviderType } from '../types';

// モックプロバイダーの作成
const createMockProvider = (provider: CloudProviderType): ICloudProvider => ({
  provider,
  displayName: `Mock ${provider.toUpperCase()} Provider`,
  validateCredentials: vi.fn().mockResolvedValue(true),
  deployStack: vi
    .fn()
    .mockResolvedValue({ success: true, startedAt: new Date() }),
  getStackStatus: vi.fn().mockResolvedValue(null),
  deleteStack: vi
    .fn()
    .mockResolvedValue({ success: true, startedAt: new Date() }),
  getStackOutputs: vi.fn().mockResolvedValue({}),
  uploadStaticFiles: vi.fn().mockResolvedValue('https://example.com/files'),
  cleanupResources: vi.fn().mockResolvedValue({
    success: true,
    deletedResources: [],
    failedResources: [],
    totalDeleted: 0,
    totalFailed: 0,
    dryRun: false,
  }),
  getAvailableRegions: vi.fn().mockResolvedValue([]),
  getAccountInfo: vi.fn().mockResolvedValue({
    accountId: '123456789012',
    provider,
  }),
});

describe('CloudProviderFactory', () => {
  let factory: CloudProviderFactory;

  beforeEach(() => {
    // 各テスト前にシングルトンをクリア
    factory = CloudProviderFactory.getInstance();
    factory.clearProviders();
  });

  describe('getInstance', () => {
    it('シングルトンインスタンスを返すべき', () => {
      const instance1 = CloudProviderFactory.getInstance();
      const instance2 = CloudProviderFactory.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('registerProvider', () => {
    it('プロバイダーを登録できるべき', () => {
      const mockProvider = createMockProvider('aws');
      factory.registerProvider(mockProvider);

      expect(factory.hasProvider('aws')).toBe(true);
    });

    it('同じプロバイダーを登録すると上書きされるべき（警告付き）', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockProvider1 = createMockProvider('aws');
      const mockProvider2 = createMockProvider('aws');

      factory.registerProvider(mockProvider1);
      factory.registerProvider(mockProvider2);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cloud provider 'aws' is already registered")
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getProvider', () => {
    it('登録済みプロバイダーを取得できるべき', () => {
      const mockProvider = createMockProvider('aws');
      factory.registerProvider(mockProvider);

      const retrieved = factory.getProvider('aws');
      expect(retrieved).toBe(mockProvider);
    });

    it('未登録のプロバイダーを取得しようとするとエラーになるべき', () => {
      expect(() => factory.getProvider('aws')).toThrow(
        "Cloud provider 'aws' is not registered"
      );
    });

    it('エラーメッセージに登録済みプロバイダー一覧が含まれるべき', () => {
      factory.registerProvider(createMockProvider('gcp'));
      factory.registerProvider(createMockProvider('local'));

      expect(() => factory.getProvider('aws')).toThrow(
        /Available providers:.*gcp.*local/
      );
    });
  });

  describe('getRegisteredProviders', () => {
    it('登録済みプロバイダー一覧を取得できるべき', () => {
      factory.registerProvider(createMockProvider('aws'));
      factory.registerProvider(createMockProvider('gcp'));

      const providers = factory.getRegisteredProviders();
      expect(providers).toContain('aws');
      expect(providers).toContain('gcp');
      expect(providers).toHaveLength(2);
    });

    it('プロバイダーが未登録の場合は空配列を返すべき', () => {
      const providers = factory.getRegisteredProviders();
      expect(providers).toHaveLength(0);
    });
  });

  describe('unregisterProvider', () => {
    it('プロバイダーの登録を解除できるべき', () => {
      factory.registerProvider(createMockProvider('aws'));
      factory.unregisterProvider('aws');

      expect(factory.hasProvider('aws')).toBe(false);
    });

    it('未登録のプロバイダーを解除してもエラーにならないべき', () => {
      expect(() => factory.unregisterProvider('aws')).not.toThrow();
    });
  });

  describe('hasProvider', () => {
    it('登録済みプロバイダーに対してtrueを返すべき', () => {
      factory.registerProvider(createMockProvider('aws'));
      expect(factory.hasProvider('aws')).toBe(true);
    });

    it('未登録のプロバイダーに対してfalseを返すべき', () => {
      expect(factory.hasProvider('aws')).toBe(false);
    });
  });

  describe('clearProviders', () => {
    it('全てのプロバイダーをクリアできるべき', () => {
      factory.registerProvider(createMockProvider('aws'));
      factory.registerProvider(createMockProvider('gcp'));

      factory.clearProviders();

      expect(factory.getRegisteredProviders()).toHaveLength(0);
    });
  });
});

describe('Helper Functions', () => {
  beforeEach(() => {
    CloudProviderFactory.getInstance().clearProviders();
  });

  describe('getCloudProviderFactory', () => {
    it('ファクトリーインスタンスを返すべき', () => {
      const factory = getCloudProviderFactory();
      expect(factory).toBeInstanceOf(CloudProviderFactory);
    });

    it('シングルトンを返すべき', () => {
      const factory1 = getCloudProviderFactory();
      const factory2 = getCloudProviderFactory();
      expect(factory1).toBe(factory2);
    });
  });

  describe('getCloudProvider', () => {
    it('登録済みプロバイダーを取得できるべき', () => {
      const mockProvider = createMockProvider('aws');
      getCloudProviderFactory().registerProvider(mockProvider);

      const provider = getCloudProvider('aws');
      expect(provider).toBe(mockProvider);
    });

    it('未登録のプロバイダーを取得しようとするとエラーになるべき', () => {
      expect(() => getCloudProvider('aws')).toThrow(
        "Cloud provider 'aws' is not registered"
      );
    });
  });
});
